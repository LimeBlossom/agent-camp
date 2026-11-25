/**
 * The Electron half of the snip: freeze the screen, one overlay per monitor to
 * drag a region on, then the note window. The session order (snipSession.ts)
 * and every piece of geometry (shared/snip.ts) are tested; this file is the
 * glue that only a live run exercises.
 *
 * The screen is captured BEFORE any overlay exists, so the frozen image never
 * shows Camp's own windows, and the overlays draw that image rather than being
 * transparent: what the human drags over is exactly what gets cropped.
 */
import { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, type NativeImage, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { loadRendererView } from './campRenderer';
import { brandTitle } from './themePacks';
import { centeredBounds, cropRect, displaySlices, globalRect, virtualDesktopSize, type Rect, type SnipDisplay } from '../shared/snip';
import { collectSnipContext, windowStack, type SnipContext, type SnipContextDeps } from './snipContext';
import type { SnipSessionDeps } from './snipSession';

const NOTE_SIZE = { width: 520, height: 420 };
const RUN_TIMEOUT_MS = 3000;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 10_000;
const CAPTURE_MAX_BUFFER = 512 * 1024 * 1024;
/** How much of a log file is read: its end only, since Editor.log runs to many MB. */
const LOG_READ_MAX_BYTES = 512 * 1024;
const BACKDROP_JPEG_QUALITY = 90;
const BGRA = 4;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: RUN_MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function runBuffer(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: CAPTURE_MAX_BUFFER, encoding: 'buffer' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** A /proc file whole; any other file only its last LOG_READ_MAX_BYTES. A missing file is null. */
function readText(path: string): string | null {
  try {
    if (path.startsWith('/proc/')) return readFileSync(path, 'utf8');
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, LOG_READ_MAX_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

const toSnipDisplay = (d: Electron.Display): SnipDisplay => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor });

const slice = (whole: NativeImage, displays: SnipDisplay[]): Map<number, NativeImage> =>
  new Map(displaySlices(whole.getSize(), displays).map(({ displayId, crop }) => [displayId, whole.crop(crop)]));

/** The X11 root window through ImageMagick: the whole virtual desktop at device pixels, in one shot. */
async function captureRoot(displays: SnipDisplay[]): Promise<Map<number, NativeImage>> {
  const size = virtualDesktopSize(displays);
  const raw = await runBuffer('import', ['-silent', '-window', 'root', '-depth', '8', 'bgra:-']);
  if (raw.length !== size.width * size.height * BGRA) {
    throw new Error(`root capture is ${raw.length} bytes, expected ${size.width}x${size.height}`);
  }
  // The root window has no alpha channel; make every pixel opaque so the PNG is too.
  for (let i = 3; i < raw.length; i += BGRA) raw[i] = 255;
  return slice(nativeImage.createFromBitmap(raw, size), displays);
}

/** Chromium's capturer, when ImageMagick is missing or fails: per-monitor sources, or one desktop-wide source sliced. */
async function captureChromium(displays: SnipDisplay[]): Promise<Map<number, NativeImage>> {
  const size = virtualDesktopSize(displays);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const byDisplay = new Map(sources.filter((s) => !s.thumbnail.isEmpty()).map((s) => [s.display_id, s.thumbnail]));
  if (displays.every((d) => byDisplay.has(String(d.id)))) {
    return new Map(displays.map((d) => {
      const want = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
      const img = byDisplay.get(String(d.id)) as NativeImage;
      const got = img.getSize();
      return [d.id, got.width === want.width && got.height === want.height ? img : img.resize(want)];
    }));
  }
  const whole = sources.length === 1 ? sources[0].thumbnail : null;
  if (!whole || whole.isEmpty()) throw new Error(`desktopCapturer gave ${sources.length} screen sources for ${displays.length} monitors`);
  const got = whole.getSize();
  return slice(got.width === size.width && got.height === size.height ? whole : whole.resize(size), displays);
}

async function captureDisplays(displays: SnipDisplay[], log: (line: string) => void): Promise<Map<number, NativeImage>> {
  try {
    return await captureRoot(displays);
  } catch (e) {
    log(`snip: ImageMagick root capture failed (${(e as Error).message}); using desktopCapturer`);
    return captureChromium(displays);
  }
}

interface Overlay { win: BrowserWindow; display: SnipDisplay; frame: NativeImage; backdrop: string }
interface NoteWindow { win: BrowserWindow; image: string; app: string }

export interface SnipWindowsOptions { rendererUrl: string | undefined; log: (line: string) => void }

/** The overlay and note windows plus their IPC. Call once. */
export function createSnipWindows(opts: SnipWindowsOptions) {
  let overlays: Overlay[] = [];
  let finishRegion: ((r: { rect: Rect; png: Buffer; display: SnipDisplay } | null) => void) | null = null;
  let note: NoteWindow | null = null;
  let finishNote: ((text: string | null) => void) | null = null;
  let lastDisplay: Electron.Display | null = null;

  const overlayOf = (wc: WebContents): Overlay | undefined => overlays.find((o) => !o.win.isDestroyed() && o.win.webContents === wc);
  const isNote = (wc: WebContents): boolean => !!note && !note.win.isDestroyed() && note.win.webContents === wc;

  const makeWindow = (view: 'snip' | 'snipNote', options: Electron.BrowserWindowConstructorOptions): BrowserWindow => {
    const win = new BrowserWindow({
      ...options,
      show: false,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'snip'
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loadRendererView(win, { view, rendererUrl: opts.rendererUrl });
    return win;
  };

  const endRegion = (result: { rect: Rect; png: Buffer; display: SnipDisplay } | null): void => {
    const done = finishRegion;
    finishRegion = null;
    const closing = overlays;
    overlays = [];
    for (const o of closing) if (!o.win.isDestroyed()) o.win.destroy();
    done?.(result);
  };

  const endNote = (text: string | null): void => {
    const done = finishNote;
    finishNote = null;
    const closing = note;
    note = null;
    if (closing && !closing.win.isDestroyed()) closing.win.destroy();
    done?.(text);
  };

  ipcMain.handle('snip:overlayImage', (evt) => overlayOf(evt.sender)?.backdrop ?? null);
  ipcMain.on('snip:region', (evt, rect: unknown) => {
    const o = overlayOf(evt.sender);
    const r = rect as Partial<Rect> | null;
    if (!o || !r || ![r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const local = r as Rect;
    const crop = cropRect(local, o.display.scaleFactor, o.frame.getSize());
    if (crop.width <= 0 || crop.height <= 0) return;
    endRegion({ rect: globalRect(o.display, local), png: o.frame.crop(crop).toPNG(), display: o.display });
  });
  ipcMain.on('snip:cancel', (evt) => { if (overlayOf(evt.sender)) endRegion(null); });
  ipcMain.handle('snip:noteInit', (evt) => (isNote(evt.sender) && note ? { image: note.image, app: note.app } : null));
  ipcMain.on('snip:noteSubmit', (evt, text: unknown) => { if (isNote(evt.sender)) endNote(typeof text === 'string' ? text : ''); });
  ipcMain.on('snip:noteDiscard', (evt) => { if (isNote(evt.sender)) endNote(null); });

  async function pickRegion(): Promise<{ rect: Rect; png: Buffer } | null> {
    const all = screen.getAllDisplays();
    const displays = all.map(toSnipDisplay);
    const frames = await captureDisplays(displays, opts.log);
    const missing = displays.filter((d) => !frames.has(d.id)).map((d) => d.id);
    if (missing.length) throw new Error(`no capture for monitor ${missing.join(', ')}`);
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const result = await new Promise<{ rect: Rect; png: Buffer; display: SnipDisplay } | null>((resolve) => {
      finishRegion = resolve;
      overlays = displays.map((display) => {
        const frame = frames.get(display.id) as NativeImage;
        const win = makeWindow('snip', {
          ...display.bounds,
          frame: false,
          fullscreen: true,
          alwaysOnTop: true,
          resizable: false,
          movable: false,
          hasShadow: false,
          enableLargerThanScreen: true,
          backgroundColor: '#000000',
          title: `${brandTitle()} - snip`
        });
        win.setAlwaysOnTop(true, 'screen-saver');
        const backdrop = `data:image/jpeg;base64,${frame.toJPEG(BACKDROP_JPEG_QUALITY).toString('base64')}`;
        win.once('ready-to-show', () => {
          win.show();
          if (display.id === cursor.id) win.focus();
        });
        win.on('closed', () => { if (finishRegion && overlays.some((o) => o.win === win)) endRegion(null); });
        return { win, display, frame, backdrop };
      });
    });
    if (!result) return null;
    lastDisplay = all.find((d) => d.id === result.display.id) ?? null;
    return { rect: result.rect, png: result.png };
  }

  async function askNote(png: Buffer, context: SnipContext): Promise<string | null> {
    if (note) endNote(null);
    const area = (lastDisplay ?? screen.getPrimaryDisplay()).workArea;
    const app = context.window.title || context.window.processName || 'screen';
    return new Promise<string | null>((resolve) => {
      finishNote = resolve;
      const win = makeWindow('snipNote', {
        ...centeredBounds(area, NOTE_SIZE),
        alwaysOnTop: true,
        resizable: false,
        title: `${brandTitle()} - snip note`
      });
      note = { win, image: `data:image/png;base64,${png.toString('base64')}`, app };
      win.once('ready-to-show', () => { win.show(); win.focus(); });
      win.on('closed', () => { if (finishNote && note?.win === win) endNote(null); });
    });
  }

  return { pickRegion, askNote };
}

/** The real X11, /proc and file access behind the session's context step. */
export function snipContextDeps(campPid: number, home: string, userData: string, hiveRoot: string | null): SnipContextDeps {
  return { run, readText, campPid, home, userData, hiveRoot };
}

export function snipSessionDeps(
  windows: ReturnType<typeof createSnipWindows>,
  contextDeps: () => SnipContextDeps,
  file: SnipSessionDeps['file'],
  log: (line: string) => void
): SnipSessionDeps {
  return {
    stack: () => windowStack({ run }),
    pickRegion: windows.pickRegion,
    context: (stack, rect) => collectSnipContext(stack, rect, contextDeps()),
    askNote: windows.askNote,
    file,
    log,
    now: () => new Date()
  };
}

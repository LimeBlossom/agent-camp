/**
 * Desktop mode: the agents' characters pacing along the bottom of the screen in
 * a borderless, transparent strip, with pop-ups above it (ASK ME, and a chat
 * with one agent) that open only when needed.
 *
 * The PRIMARY window is hidden, never closed. Its renderer runs the hive's
 * heartbeat loops and owns every PTY, so closing it would stop the floor. The
 * desktop windows run none of that: they draw from a state slice the primary
 * publishes over IPC, and a chat message is handed back to the primary to
 * enqueue, exactly as its own composer would.
 *
 * They also run on an in-memory session partition, and `isDesktopSender` lets
 * main refuse their roster writes. The renderer store writes roster.json from
 * inside its actions, and a desktop window's copy of the roster is a mirror; a
 * click on a character (`select`) would otherwise overwrite the real roster
 * with it.
 */
import { app, BrowserWindow, ipcMain, screen, session, type WebContents } from 'electron';
import { join } from 'node:path';
import { loadRendererView } from './campRenderer';
import { brandTitle } from './themePacks';
import { noteActions } from './agentActionClock';

type Popup = 'askme' | 'talk';
type View = 'strip' | Popup;

const POPUP_SIZE: Record<Popup, { width: number; height: number }> = {
  askme: { width: 560, height: 420 },
  talk: { width: 460, height: 360 },
};
const GAP = 8;
const DEFAULT_STRIP_HEIGHT = 150;

let host: BrowserWindow | null = null;
let strip: BrowserWindow | null = null;
const popups: Partial<Record<Popup, BrowserWindow>> = {};
let stripHeight = DEFAULT_STRIP_HEIGHT;
let lastState: unknown = null;
let talkTarget: string | null = null;
/** The primary window's renderer, which publishes state and enqueues messages. */
let publisher: WebContents | null = null;

/** The primary's latest published store slice, for the desktop windows and the phone view. */
export function publishedState(): unknown { return lastState; }

/** Hand a message to the primary to enqueue as its composer would; false when there is none. */
export function enqueueToPrimary(agentId: string, text: string): boolean {
  if (!publisher || publisher.isDestroyed()) return false;
  publisher.send('desktop:enqueue', { agentId, text });
  return true;
}

function alive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return !!win && !win.isDestroyed();
}

export function isDesktopSender(wc: WebContents): boolean {
  return [strip, popups.askme, popups.talk].some((w) => alive(w) && w.webContents === wc);
}

function loadView(win: BrowserWindow, view: View, rendererUrl: string | undefined): void {
  loadRendererView(win, { view, rendererUrl });
}

function makeWindow(view: View, bounds: Electron.Rectangle, rendererUrl: string | undefined): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: `${brandTitle()} - ${view}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'desktop',
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  // The strip starts inactive so entering desktop mode doesn't steal focus; a
  // pop-up takes it, because the reason it opened is to be typed into.
  win.once('ready-to-show', () => (view === 'strip' ? win.showInactive() : win.show()));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loadView(win, view, rendererUrl);
  return win;
}

function workArea(): Electron.Rectangle {
  const anchor = alive(host) ? host.getBounds() : undefined;
  return (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea;
}

function stripBounds(): Electron.Rectangle {
  const wa = workArea();
  const height = Math.min(stripHeight, Math.round(wa.height / 3));
  return { x: wa.x, y: wa.y + wa.height - height, width: wa.width, height };
}

function popupBounds(which: Popup): Electron.Rectangle {
  const wa = workArea();
  const top = stripBounds().y;
  const size = POPUP_SIZE[which];
  const width = Math.min(size.width, wa.width - 2 * GAP);
  const height = Math.min(size.height, top - wa.y - 2 * GAP);
  const x = which === 'askme' ? wa.x + wa.width - width - GAP : wa.x + GAP;
  return { x, y: top - height - GAP, width, height };
}

function tellStrip(which: Popup, shown: boolean): void {
  if (alive(strip)) strip.webContents.send('desktop:popupShown', { which, shown });
}

function showPopup(which: Popup, show: boolean, rendererUrl: string | undefined): void {
  if (!alive(strip)) return;
  const win = popups[which];
  if (show) {
    if (alive(win)) { win.show(); win.focus(); }
    else {
      const made = makeWindow(which, popupBounds(which), rendererUrl);
      made.on('closed', () => { if (popups[which] === made) delete popups[which]; tellStrip(which, false); });
      popups[which] = made;
    }
  } else if (alive(win)) {
    win.hide();
  }
  tellStrip(which, show);
}

function exit(): void {
  const s = strip;
  strip = null;
  for (const which of Object.keys(popups) as Popup[]) {
    const w = popups[which];
    delete popups[which];
    if (alive(w)) w.destroy();
  }
  if (alive(s)) s.destroy();
  if (alive(host)) {
    host.webContents.send('desktop:mode', false);
    host.show();
    host.focus();
  }
  host = null;
}

function isRect(r: unknown): r is Electron.Rectangle {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k] as number));
}

/** Call before `app` is ready: the Linux transparency switch only applies then. */
export function registerDesktopMode(opts: { rendererUrl: string | undefined }): void {
  // Without it, transparent windows on some Linux compositors come up black.
  if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

  ipcMain.handle('desktop:enter', (evt) => {
    if (alive(strip)) return;
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) return;
    host = win;
    host.webContents.send('desktop:mode', true);
    strip = makeWindow('strip', stripBounds(), opts.rendererUrl);
    strip.on('closed', () => { if (strip) exit(); });
    host.hide();
  });

  ipcMain.handle('desktop:exit', () => exit());

  // The strip asks for the height its characters need, so resizing them resizes it.
  ipcMain.handle('desktop:setHeight', (_evt, px: unknown) => {
    if (!alive(strip) || typeof px !== 'number' || !(px > 0)) return;
    stripHeight = Math.round(px);
    strip.setBounds(stripBounds());
    for (const which of Object.keys(popups) as Popup[]) {
      const w = popups[which];
      if (alive(w)) w.setBounds(popupBounds(which));
    }
  });

  // Click-through. Outside these rects the strip neither draws nor takes the
  // mouse, so the desktop under its empty stretches stays usable. It is the
  // only option on Linux: setIgnoreMouseEvents' `forward` is macOS/Windows only.
  ipcMain.on('desktop:shape', (evt, rects: unknown) => {
    if (!alive(strip) || evt.sender !== strip.webContents || !Array.isArray(rects)) return;
    const clean = rects.filter(isRect).map((r) => ({
      x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)),
    }));
    try { strip.setShape(clean); } catch { /* unsupported platform: the whole strip stays clickable */ }
  });

  ipcMain.handle('desktop:askMe', (_evt, show: unknown) => showPopup('askme', show === true, opts.rendererUrl));

  ipcMain.handle('desktop:talk', (_evt, agentId: unknown) => {
    if (typeof agentId === 'string' && agentId) {
      talkTarget = agentId;
      for (const w of [strip, popups.talk]) if (alive(w)) w.webContents.send('desktop:talkTarget', agentId);
      showPopup('talk', true, opts.rendererUrl);
    } else {
      showPopup('talk', false, opts.rendererUrl);
    }
  });
  ipcMain.handle('desktop:getTalkTarget', () => talkTarget);

  // A chat message from the talk pop-up, handed to the primary to enqueue.
  ipcMain.handle('desktop:send', (evt, agentId: unknown, text: unknown) => {
    if (!isDesktopSender(evt.sender)) return false;
    if (typeof agentId !== 'string' || typeof text !== 'string' || !text.trim()) return false;
    return enqueueToPrimary(agentId, text);
  });

  // Only the primary publishes: it is on the default session, while floor windows
  // (and the desktop windows) run on partitions with their own agents or none.
  ipcMain.on('desktop:publish', (evt, state: unknown) => {
    if (evt.sender.session !== session.defaultSession) return;
    publisher = evt.sender;
    lastState = state;
    noteActions(state);
    for (const w of [strip, popups.askme, popups.talk]) if (alive(w)) w.webContents.send('desktop:state', state);
  });

  ipcMain.handle('desktop:getState', () => lastState);
}

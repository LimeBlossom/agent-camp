/**
 * Hotkey snip to a card: the pure parts shared by main and the two snip views.
 * Accelerators, the overlay's drag geometry, the note window's key rules and
 * its placement. Framework-free so `node --test` covers all of it.
 */
import { isComposingKey, type ComposingKeyEvent } from './imeGuard';

/**
 * the human's pick (11-21). Free in Cinnamon and Unity. No Super combo can be the default:
 * Cinnamon's menu binds the bare Super key, which swallows every Super combo before a global grab.
 */
export const DEFAULT_SNIP_HOTKEY = 'Shift+F12';

/** Earlier defaults the desktop kills, rewritten to the current one only where it does (migratedSnipHotkey). */
const DEAD_OLD_DEFAULT_SNIP_HOTKEYS: readonly string[] = ['Super+Shift+S'];

/** Earlier defaults that still fire but were replaced by the human's pick: rewritten once, so choosing one again later sticks. */
const REPLACED_OLD_DEFAULT_SNIP_HOTKEYS: readonly string[] = ['Ctrl+Alt+Shift+S'];

/** Stored as config.snipDefaultsVersion once the replaced defaults have been rewritten. */
export const SNIP_DEFAULTS_VERSION = 1;

/** Keybindings the desktop reports at runtime (main/cinnamonKeys.ts), on top of the built-in table. */
export interface DesktopBindings {
  /** Canonical accelerator to the label of what binds it. */
  clashes: ReadonlyMap<string, string>;
  /** What binds the bare Super key, or null when nothing does. */
  superOverlay: string | null;
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Super', 'Shift'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl', control: 'Ctrl', cmdorctrl: 'Ctrl', commandorcontrol: 'Ctrl',
  alt: 'Alt', option: 'Alt', altgr: 'Alt',
  shift: 'Shift',
  super: 'Super', meta: 'Super', cmd: 'Super', command: 'Super'
};

/** Electron's names for the non-letter keys, keyed by lower case, plus the spellings people type. */
const KEY_NAMES: Record<string, string> = Object.fromEntries([
  'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace',
  'Tab', 'Space', 'Escape', 'Return', 'Plus', 'PrintScreen', 'Capslock', 'Numlock', 'Scrolllock',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
  ...Array.from({ length: 10 }, (_, i) => `num${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)
].map((k) => [k.toLowerCase(), k]).concat([
  ['print', 'PrintScreen'], ['prtsc', 'PrintScreen'], ['esc', 'Escape'], ['enter', 'Return'], ['del', 'Delete']
]));

/** One spelling per shortcut: modifiers as Ctrl, Alt, Super, Shift in that order, then the key. */
export function canonicalAccelerator(acc: string): string {
  const parts = acc.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set<Modifier>();
  const keys: string[] = [];
  for (const p of parts) {
    const mod = MODIFIER_ALIASES[p.toLowerCase()];
    if (mod) mods.add(mod);
    else keys.push(p.length === 1 ? p.toUpperCase() : KEY_NAMES[p.toLowerCase()] ?? p[0].toUpperCase() + p.slice(1));
  }
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), ...keys].join('+');
}

/** Why Electron would refuse this accelerator's key, or null when it names one key it knows. Blank is off, so null. */
export function snipKeyError(acc: string): string | null {
  if (!acc.trim()) return null;
  const keys = acc.split('+').map((p) => p.trim()).filter((p) => p && !MODIFIER_ALIASES[p.toLowerCase()]);
  if (keys.length === 0) return `${acc.trim()} has no key, only modifiers`;
  if (keys.length > 1) return `${acc.trim()} has two keys (${keys.join(', ')}); a shortcut takes one`;
  const key = keys[0];
  const known = key.length === 1 ? /\S/.test(key) : key.toLowerCase() in KEY_NAMES;
  return known ? null : `${key} is not a key name Electron can register`;
}

const GTK_MODIFIERS: Record<string, Modifier> = {
  primary: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', mod1: 'Alt',
  shift: 'Shift', super: 'Super', meta: 'Super', mod4: 'Super'
};

/** X keysym names GTK writes for punctuation, as the character Electron accelerators use. */
const GTK_KEYSYMS: Record<string, string> = {
  grave: '`', minus: '-', equal: '=', comma: ',', period: '.', slash: '/', backslash: '\\',
  semicolon: ';', apostrophe: "'", bracketleft: '[', bracketright: ']'
};

const BARE_SUPER_KEYSYMS = new Set(['super_l', 'super_r', 'super']);

/**
 * A GTK keybinding value ('<Shift><Super>s', several joined by '::') as canonical
 * accelerators. A bare Super_L or Super_R comes back as 'Super'; empty slots are dropped.
 */
export function gtkAccelerators(value: string): string[] {
  const out: string[] = [];
  for (const slot of value.split('::')) {
    const mods: string[] = [];
    const key = slot.trim().replace(/<([^>]+)>/g, (_, m: string) => { mods.push(GTK_MODIFIERS[m.toLowerCase()] ?? m); return ''; }).trim();
    if (!key) continue;
    if (BARE_SUPER_KEYSYMS.has(key.toLowerCase()) && mods.length === 0) { out.push('Super'); continue; }
    out.push(canonicalAccelerator([...mods, GTK_KEYSYMS[key.toLowerCase()] ?? key].join('+')));
  }
  return out;
}

const ARROWS = ['Left', 'Right', 'Up', 'Down'];

/** Bindings a global grab would steal, in canonical spelling. */
const CLASHES: ReadonlyArray<[string[], string]> = [
  [['PrintScreen'], 'Cinnamon: screenshot'],
  [['Shift+PrintScreen'], 'Cinnamon: area screenshot'],
  [['Alt+PrintScreen'], 'Cinnamon: window screenshot'],
  [['Ctrl+PrintScreen', 'Ctrl+Shift+PrintScreen', 'Ctrl+Alt+PrintScreen'], 'Cinnamon: screenshot to clipboard'],
  [['Ctrl+Alt+Shift+R'], 'Cinnamon: record the desktop'],
  [['Super+S'], 'Cinnamon: show desklets'],
  [['Super+E'], 'Cinnamon: home folder'],
  [['Super+D', 'Ctrl+Alt+D'], 'Cinnamon: show desktop'],
  [['Super+L', 'Ctrl+Alt+L'], 'Cinnamon: lock screen'],
  [['Super+P'], 'Cinnamon: display settings'],
  [['Super+O'], 'Cinnamon: rotation lock'],
  [['Super+H'], 'Cinnamon: minimize window'],
  [ARROWS.map((a) => `Super+${a}`), 'Cinnamon: tile window'],
  [[...ARROWS, 'Home', 'End', 'PageUp', 'PageDown'].map((a) => `Super+Shift+${a}`), 'Cinnamon: move window to another monitor'],
  [ARROWS.map((a) => `Ctrl+Alt+${a}`), 'Cinnamon: switch workspace'],
  [ARROWS.map((a) => `Ctrl+Alt+Shift+${a}`), 'Cinnamon: move window to another workspace'],
  [['Ctrl+Alt+T'], 'Cinnamon: terminal'],
  [['Ctrl+Alt+Delete'], 'Cinnamon: log out'],
  [['Ctrl+Alt+Escape'], 'Cinnamon: restart Cinnamon'],
  [['Alt+F2'], 'Cinnamon: run command'],
  [['Alt+F4'], 'Cinnamon: close window'],
  [['Alt+Tab', 'Alt+Shift+Tab', 'Super+Tab'], 'Cinnamon: switch windows'],
  [['Ctrl+S'], 'Unity: Save'],
  [['Ctrl+Shift+S'], 'Unity: Save As'],
  [['Ctrl+P'], 'Unity: Play'],
  [['Ctrl+Shift+P'], 'Unity: Pause'],
  [['Ctrl+Alt+P'], 'Unity: Step'],
  [['Ctrl+D'], 'Unity: Duplicate'],
  [['Ctrl+Z'], 'Unity: Undo'],
  [['Ctrl+Y', 'Ctrl+Shift+Z'], 'Unity: Redo'],
  [['Ctrl+Shift+F'], 'Unity: Align With View'],
  [['Ctrl+Alt+F'], 'Unity: Move To View'],
  [['Ctrl+Shift+N'], 'Unity: Create Empty'],
  [['Ctrl+Alt+Shift+N'], 'Unity: Create Empty Child'],
  [['Ctrl+N'], 'Unity: New Scene'],
  [['Ctrl+O'], 'Unity: Open Scene'],
  [['Ctrl+B', 'Ctrl+Shift+B'], 'Unity: Build'],
  [['Ctrl+Shift+C'], 'Unity: Console'],
  [['Ctrl+Shift+M'], 'Unity: Audio Mixer'],
  [['Ctrl+K'], 'Unity: Search'],
  [['Ctrl+R'], 'Unity: Refresh'],
  [['Ctrl+F'], 'Unity: Find'],
  [['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X'], 'Unity and every app: editing'],
  [Array.from({ length: 10 }, (_, i) => `Ctrl+${i}`), 'Unity: open a window by number']
];

const CLASH_BY_ACC: ReadonlyMap<string, string> = new Map(CLASHES.flatMap(([accs, label]) => accs.map((a) => [a, label] as const)));

/** The Cinnamon or Unity binding this shortcut would steal, or null when it is free. */
export function shortcutClash(acc: string, desktop?: DesktopBindings): string | null {
  const c = canonicalAccelerator(acc);
  const known = CLASH_BY_ACC.get(c) ?? desktop?.clashes.get(c);
  if (known) return known;
  const parts = c.split('+');
  if (!parts.some((p) => p === 'Ctrl' || p === 'Alt' || p === 'Super') && parts.at(-1)?.length === 1) {
    return 'every app: typing this key';
  }
  return null;
}

/** Why a Super accelerator can never fire on this desktop, or null when it can. */
export function superBlockedReason(acc: string, desktop: DesktopBindings): string | null {
  if (!desktop.superOverlay || !canonicalAccelerator(acc).split('+').includes('Super')) return null;
  return `${desktop.superOverlay} binds the bare Super key, so no Super shortcut reaches Camp; pick one without Super, such as ${DEFAULT_SNIP_HOTKEY}`;
}

/** The hotkey to save in place of an old default this desktop kills, or null to keep the config as it is. */
export function migratedSnipHotkey(config: { snipHotkey?: string; snipDefaultsVersion?: number }, desktop: DesktopBindings): string | null {
  if (typeof config.snipHotkey !== 'string' || !config.snipHotkey.trim()) return null;
  const saved = canonicalAccelerator(config.snipHotkey);
  if (REPLACED_OLD_DEFAULT_SNIP_HOTKEYS.includes(saved) && (config.snipDefaultsVersion ?? 0) < SNIP_DEFAULTS_VERSION) return DEFAULT_SNIP_HOTKEY;
  return DEAD_OLD_DEFAULT_SNIP_HOTKEYS.includes(saved) && superBlockedReason(saved, desktop) ? DEFAULT_SNIP_HOTKEY : null;
}

/** What the Settings field should send on Save: its canonical value, "" to turn it off, or null when it names the saved shortcut. */
export function snipHotkeyEdit(field: string, saved: string): string | null {
  const next = field.trim() ? canonicalAccelerator(field) : '';
  const was = saved.trim() ? canonicalAccelerator(saved) : '';
  return next === was ? null : next;
}

/** The hotkey the config asks for: unset is the default, an empty string turns it off. */
export function snipHotkeyOf(config: { snipHotkey?: string }): string {
  return typeof config.snipHotkey === 'string' ? config.snipHotkey.trim() : DEFAULT_SNIP_HOTKEY;
}

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

/** Smaller than this on either side is a click or a slip, not a snip. */
export const MIN_SNIP_PX = 8;

/** The rectangle a drag from `a` to `b` covers, in either direction, or null when too small to be a snip. */
export function dragRect(a: Point, b: Point): Rect | null {
  const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  return rect.width >= MIN_SNIP_PX && rect.height >= MIN_SNIP_PX ? rect : null;
}

/** `rect` in device pixels (times `scale`), clamped to the image. */
export function cropRect(rect: Rect, scale: number, image: Size): Rect {
  const x = Math.min(Math.max(0, Math.round(rect.x * scale)), image.width);
  const y = Math.min(Math.max(0, Math.round(rect.y * scale)), image.height);
  return {
    x, y,
    width: Math.max(0, Math.min(Math.round(rect.width * scale), image.width - x)),
    height: Math.max(0, Math.min(Math.round(rect.height * scale), image.height - y))
  };
}

export interface SnipDisplay { id: number; bounds: Rect; scaleFactor: number }

/** A rectangle drawn on one monitor's overlay, in global X11 pixels. */
export function globalRect(display: SnipDisplay, local: Rect): Rect {
  const s = display.scaleFactor;
  return {
    x: Math.round((display.bounds.x + local.x) * s),
    y: Math.round((display.bounds.y + local.y) * s),
    width: Math.round(local.width * s),
    height: Math.round(local.height * s)
  };
}

/** The part of one whole-desktop capture that each monitor shows. */
export function displaySlices(virtualSize: Size, displays: readonly SnipDisplay[]): Array<{ displayId: number; crop: Rect }> {
  return displays.map((d) => ({ displayId: d.id, crop: cropRect(d.bounds, d.scaleFactor, virtualSize) }));
}

/** The whole virtual desktop in device pixels: the size one root-window capture comes back at. */
export function virtualDesktopSize(displays: readonly SnipDisplay[]): Size {
  return {
    width: Math.max(0, ...displays.map((d) => Math.round((d.bounds.x + d.bounds.width) * d.scaleFactor))),
    height: Math.max(0, ...displays.map((d) => Math.round((d.bounds.y + d.bounds.height) * d.scaleFactor)))
  };
}

export interface NoteKeyEvent extends ComposingKeyEvent { key: string; shiftKey?: boolean }

/** What a keypress in the note field does: Enter files the card, Esc throws the snip away. */
export function noteKeyAction(e: NoteKeyEvent): 'submit' | 'discard' | null {
  if (isComposingKey(e)) return null;
  if (e.key === 'Escape') return 'discard';
  if (e.key === 'Enter' && !e.shiftKey) return 'submit';
  return null;
}

export const SNIP_TITLE_MAX = 80;

/** The card title: the note's first non-blank line, or `fallback` for an empty note. */
export function snipTitle(note: string, fallback: string): string {
  const first = note.split('\n').map((l) => l.trim()).find(Boolean) ?? fallback.trim();
  return first.length <= SNIP_TITLE_MAX ? first : `${first.slice(0, SNIP_TITLE_MAX - 3).trimEnd()}...`;
}

/** A window of `size` centred in `area`, never larger than it. */
export function centeredBounds(area: Rect, size: Size): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width, height
  };
}

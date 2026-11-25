/**
 * The one global shortcut that starts a snip. Electron-free: `api` is
 * `globalShortcut` in the app and a fake in tests, so a refused or invalid
 * registration is always reported back to settings and logged.
 */
import { canonicalAccelerator, shortcutClash, snipKeyError, superBlockedReason, type DesktopBindings } from '../shared/snip';

export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface SnipHotkeyStatus {
  /** Canonical spelling; empty when the hotkey is off. */
  accelerator: string;
  registered: boolean;
  error?: string;
  /** The Cinnamon or Unity binding it also grabs, when it registered anyway. */
  clash?: string;
}

export function createSnipHotkey(api: ShortcutApi, log: (line: string) => void) {
  let current: SnipHotkeyStatus = { accelerator: '', registered: false };

  const release = (): void => {
    if (!current.registered) return;
    try { api.unregister(current.accelerator); } catch (e) { log(`snip hotkey: could not release ${current.accelerator}: ${(e as Error).message}`); }
  };

  return {
    /**
     * Register `accelerator` (releasing the previous one); an empty string turns the hotkey off.
     * `desktop` adds the desktop's own bindings: a Super shortcut under a bare-Super overlay is
     * refused, because the grab succeeds but never fires.
     */
    arm(accelerator: string, onPress: () => void, desktop?: DesktopBindings): SnipHotkeyStatus {
      release();
      const acc = accelerator.trim() ? canonicalAccelerator(accelerator) : '';
      if (!acc) {
        current = { accelerator: '', registered: false };
        log('snip hotkey off');
        return { ...current };
      }
      const clash = shortcutClash(acc, desktop);
      const blocked = desktop ? superBlockedReason(acc, desktop) : null;
      const badKey = snipKeyError(acc);
      let next: SnipHotkeyStatus;
      if (badKey) {
        next = { accelerator: acc, registered: false, error: badKey };
      } else if (blocked) {
        next = { accelerator: acc, registered: false, error: `${acc} never fires here: ${blocked}` };
      } else try {
        next = api.register(acc, onPress)
          ? { accelerator: acc, registered: true }
          : { accelerator: acc, registered: false, error: `${acc} is taken: another app or the desktop already grabs it` };
      } catch (e) {
        next = { accelerator: acc, registered: false, error: `${acc} could not be registered: ${(e as Error).message}` };
      }
      if (clash) next.clash = clash;
      current = next;
      log(next.registered
        ? `snip hotkey armed: ${acc}${clash ? ` (also grabs ${clash})` : ''}`
        : `snip hotkey NOT armed: ${next.error}`);
      return { ...current };
    },
    status(): SnipHotkeyStatus { return { ...current }; }
  };
}

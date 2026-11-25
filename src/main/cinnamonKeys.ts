/**
 * Keybindings Cinnamon applets hold in their spice settings
 * (~/.config/cinnamon/spices/<uuid>/<instance>.json), which gsettings does not
 * list. A missing folder or an unreadable file is skipped: another desktop has none.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gtkAccelerators, type DesktopBindings } from '../shared/snip';

interface SpiceSetting { type?: unknown; value?: unknown; description?: unknown }

function listDir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export function readCinnamonBindings(spicesDir: string): DesktopBindings {
  const clashes = new Map<string, string>();
  let superOverlay: string | null = null;
  for (const uuid of listDir(spicesDir).sort()) {
    for (const file of listDir(join(spicesDir, uuid)).filter((f) => f.endsWith('.json')).sort()) {
      let settings: Record<string, SpiceSetting>;
      try { settings = JSON.parse(readFileSync(join(spicesDir, uuid, file), 'utf8')); } catch { continue; }
      if (!settings || typeof settings !== 'object') continue;
      for (const [key, s] of Object.entries(settings)) {
        if (!s || typeof s !== 'object' || s.type !== 'keybinding' || typeof s.value !== 'string') continue;
        const label = `Cinnamon applet ${uuid}: ${typeof s.description === 'string' ? s.description : key}`;
        for (const acc of gtkAccelerators(s.value)) {
          if (acc === 'Super') superOverlay ??= label;
          else if (!clashes.has(acc)) clashes.set(acc, label);
        }
      }
    }
  }
  return { clashes, superOverlay };
}

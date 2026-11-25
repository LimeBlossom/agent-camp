/**
 * One snip from hotkey to card: read the window stack, let the human drag a region,
 * collect the context under it, ask for a note, file. Electron-free; the
 * windows and X11 come in as `deps`. One snip at a time: a press while one is
 * open does nothing.
 */
import type { Rect } from '../shared/snip';
import type { SnipContext, StackWindow } from './snipContext';
import type { FileSnipResult, SnipInput } from './snipCard';

export interface SnipSessionDeps {
  /** Read BEFORE the overlay opens, or the overlay is the window under the snip. */
  stack: () => Promise<StackWindow[]>;
  /** The dragged region in global pixels and its PNG, or null on Esc. */
  pickRegion: () => Promise<{ rect: Rect; png: Buffer } | null>;
  context: (stack: StackWindow[], rect: Rect) => Promise<SnipContext>;
  /** The note, or null when the human discards the snip. */
  askNote: (png: Buffer, context: SnipContext) => Promise<string | null>;
  file: (input: SnipInput) => FileSnipResult | Promise<FileSnipResult>;
  log: (line: string) => void;
  now: () => Date;
}

export type SnipOutcome =
  | { status: 'cancelled'; at: 'region' | 'note' }
  | { status: 'filed'; cardId: string }
  | { status: 'busy' }
  | { status: 'failed'; error: string };

export function createSnipSession(deps: SnipSessionDeps) {
  let running = false;

  async function run(): Promise<SnipOutcome> {
    const now = deps.now();
    const stack = await deps.stack();
    const region = await deps.pickRegion();
    if (!region) return { status: 'cancelled', at: 'region' };
    const context = await deps.context(stack, region.rect);
    const note = await deps.askNote(region.png, context);
    if (note === null) return { status: 'cancelled', at: 'note' };
    const out = await deps.file({ note, png: region.png, context, now });
    if (!out.ok) throw new Error(out.error);
    return { status: 'filed', cardId: out.cardId };
  }

  return {
    busy: (): boolean => running,
    async start(): Promise<SnipOutcome> {
      if (running) return { status: 'busy' };
      running = true;
      try {
        const out = await run();
        deps.log(out.status === 'filed' ? `snip filed as ${out.cardId}` : `snip ${out.status}`);
        return out;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        deps.log(`snip failed: ${error}`);
        return { status: 'failed', error };
      } finally {
        running = false;
      }
    }
  };
}

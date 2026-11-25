import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Folder isolated agents' worktrees go in: the scratch drive when it is mounted, so a
 *  game-sized checkout never lands on the root disk, else `<harnessHome>/worktrees`. */
export function worktreeRoot(harnessHome: string | null | undefined, origCwd: string, scratchRoot?: string | null): string {
  if (scratchRoot && existsSync(scratchRoot)) return join(scratchRoot, 'worktrees');
  return join(harnessHome ?? origCwd, 'worktrees');
}

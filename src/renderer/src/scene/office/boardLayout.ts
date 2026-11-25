import type { Tile } from './themeRegistry';

/** Where the task-board ensemble draws its pieces, in px relative to the board
 *  Graphics' origin (the board anchor tile's top-left plus `centerPad`). The
 *  drawing code and the board-move stands both read it, so they cannot drift. */
export interface BoardLayout {
  /** The ensemble (two boards + archive) is centered on the office's wall run
   *  between its two doorways, tiles 6..12. */
  centerPad: number;
  blockedX: number;
  todoX: number;
  corkWidth: number;
  archiveX: number;
  archiveWidth: number;
  /** Lowest drawn pixel of the whole ensemble. */
  bottom: number;
}

export interface BoardStands { pin: Tile; take: Tile; archive: Tile }

const CORK_WIDTH = 30;
const CENTER_PAD = 15;

export function boardLayout(propStyle: string | undefined, sprites: boolean): BoardLayout {
  if (sprites) {
    // PMD signboards at 2x (y -10..36), the finished pile on a tree stump.
    return { centerPad: CENTER_PAD, blockedX: 0, todoX: 44, corkWidth: CORK_WIDTH, archiveX: 90, archiveWidth: 16, bottom: 36 };
  }
  // Cork frames end at y 14 and the archive table's legs at 16; the camp's
  // plank boards stand on legs down to y 20.
  return {
    centerPad: CENTER_PAD, blockedX: 0, todoX: 34, corkWidth: CORK_WIDTH, archiveX: 68, archiveWidth: 14,
    bottom: propStyle === 'camp' ? 20 : 16,
  };
}

/** How far a stand may sit from the tile under its piece before we give up. */
const MAX_STAND_DX = 4;
const MAX_STAND_DY = 3;

/** The tile an actor stands on to pin (blocked board), take (todo board) or
 *  archive (finished pile): the nearest walkable tile below the board, under or
 *  beside the piece it acts on. Falls back to the tile under the piece. */
export function boardStandTiles(
  board: Tile,
  tileSize: number,
  layout: BoardLayout,
  isWalkable: (x: number, y: number) => boolean,
): BoardStands {
  const originX = board.x * tileSize + layout.centerPad;
  const standRow = Math.floor((board.y * tileSize + layout.bottom - 1) / tileSize) + 1;
  const near = (pieceX: number, pieceWidth: number): Tile => {
    const x = Math.floor((originX + pieceX + pieceWidth / 2) / tileSize);
    for (let dy = 0; dy <= MAX_STAND_DY; dy++) {
      for (let dx = 0; dx <= MAX_STAND_DX; dx++) {
        for (const sx of dx === 0 ? [x] : [x + dx, x - dx]) {
          if (isWalkable(sx, standRow + dy)) return { x: sx, y: standRow + dy };
        }
      }
    }
    console.error(`[floor] no walkable board stand near ${x},${standRow}`);
    return { x, y: standRow };
  };
  return {
    pin: near(layout.blockedX, layout.corkWidth),
    take: near(layout.todoX, layout.corkWidth),
    archive: near(layout.archiveX, layout.archiveWidth),
  };
}

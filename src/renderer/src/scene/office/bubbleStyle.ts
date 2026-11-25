// How the thought bubbles look, set by the scene when a theme loads and read by
// each bubble as it is built. Null keeps the office's code-drawn cloud.
import type { Texture } from 'pixi.js';

export interface BubbleStyle {
  /** A 9-slice frame; `border` px on every side stretch, the middle fills. */
  frame: Texture;
  border: number;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  /** Inner padding between the frame's edge and the text, in bubble px. */
  padX: number;
  padY: number;
  /** Bubble height above the anchor (px, negative is up), for a cast shorter
   *  than the office's. */
  offsetY: number;
  /** Colours for the trailing puffs, matching the frame. */
  puffFill: number;
  puffOutline: number;
}

let current: BubbleStyle | null = null;

export function setBubbleStyle(style: BubbleStyle | null): void { current = style; }
export function bubbleStyle(): BubbleStyle | null { return current; }

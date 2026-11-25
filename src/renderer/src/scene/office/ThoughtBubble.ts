import { Container, Graphics, NineSliceSprite, Text } from 'pixi.js';
import { bubbleStyle, type BubbleStyle } from './bubbleStyle';
import { colors } from '@/design/tokens';
import { toolIcon } from './ToolBubble';

// A comic "thought cloud" pinned above an avatar's head showing what it's doing
// RIGHT NOW (the agent's live `action`, e.g. "edit App.tsx" / "bash npm test").
// Distinct from the darker ToolBubble speech bubble: a light cream cloud with a
// trailing-puff tail — the visual shorthand for "thinking". Built to DESIGN.md:
// integer pixels, hard 1px ink outline, limited palette, no soft shadows.
//
// Shares ToolBubble's fade state machine and word-wrapping so behaviour reads
// consistently; the differences are the look (cloud + tail, light fill) and that
// it stays put until the action changes (no auto-linger while the agent works).

const PADDING_X = 6;
const PADDING_Y = 3;
const CORNER_RADIUS = 5;
const MAX_WIDTH = 150;
const FILL_COLOR = colors.cream[50];   // light cloud
const OUTLINE_COLOR = colors.ink[900];
const TEXT_COLOR = '#3d2e4a';           // ink-700
const FONT_SIZE = 12;
const RENDER_SCALE = 0.5;               // render at 2x, scale down for crispness
const OFFSET_Y = -38;                   // a touch higher than the tool bubble
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 1.2;            // only used when hide() is requested
const DOTS_CYCLE_SPEED = 0.45;
// Word-wrap width in the inner (unscaled) space — the inner container renders at
// RENDER_SCALE, so the on-screen cap is MAX_WIDTH. breakWords splits unbroken
// tokens (long paths/hashes) that would otherwise still spill past the cloud.
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
// Hard cap on raw characters so a pathological action string wraps to a few
// lines instead of a runaway-tall cloud (~4 lines at this width).
const MAX_CHARS = 160;

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const stripEmoji = (t: string): string => t.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();

type BubbleState = 'hidden' | 'fading-in' | 'visible' | 'lingering' | 'fading-out';

export class ThoughtBubble {
  readonly container: Container;
  private inner: Container;
  private bg: Graphics;
  private frame: NineSliceSprite | null = null;
  private style: BubbleStyle | null;
  private tail: Graphics;
  private label: Text;
  private state: BubbleState = 'hidden';
  private fadeElapsed = 0;
  private lingerElapsed = 0;
  private bgW = 0;
  private bgH = 0;
  private isThinking = false;
  private dotsElapsed = 0;
  private dotsPhase = 0;
  // Extra upward shift (px) applied on top of OFFSET_Y so two nearby bubbles can
  // stack instead of overlapping. Set each frame by the scene's overlap pass.
  private extraLift = 0;
  // Where the puffs point, in inner (unscaled) x: the avatar's position under the
  // bubble, which is not its middle once the bubble is clamped or lifted.
  private tailX = -1;
  // Current camera zoom. The bubble lives inside the zoomed world container, so
  // when the window shrinks (fit-to-screen zoom < 1) the text used to scale
  // down with the map and turn into ragged mush. Counter-scale so the bubble
  // never renders below its designed 1:1 screen size; at zoom ≥ 1 it keeps
  // scaling with the world as before.
  private zoom = 1;
  // World bounds (map size in px). An avatar near the map edge — Michael's CEO
  // room sits in the top-left corner — would otherwise push its cloud out of
  // the visible world. setPosition clamps the rect back inside, tooltip-style.
  private boundsW = 0;
  private boundsH = 0;

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100000;
    this.container.eventMode = 'none';
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

    this.tail = new Graphics();
    this.bg = new Graphics();
    this.style = bubbleStyle();
    const st = this.style;
    this.label = new Text({
      text: '',
      style: {
        fontSize: st?.fontSize ?? FONT_SIZE,
        fontWeight: st ? 'normal' : 'bold',
        fill: st?.textColor ?? TEXT_COLOR,
        fontFamily: st ? `${st.fontFamily}, monospace` : 'monospace',
        align: 'left',
        wordWrap: true,
        wordWrapWidth: WRAP_WIDTH,
        breakWords: true
      }
    });
    this.label.x = st?.padX ?? PADDING_X;
    this.label.y = st?.padY ?? PADDING_Y;

    // tail first so it sits behind the body
    this.inner.addChild(this.tail, this.bg, this.label);
    if (st) {
      const b = st.border;
      this.frame = new NineSliceSprite({ texture: st.frame, leftWidth: b, topHeight: b, rightWidth: b, bottomHeight: b });
      this.inner.addChildAt(this.frame, this.inner.getChildIndex(this.bg));
    }
  }

  /** Show the current activity. Empty text → an animated "…" (model thinking).
   *  `tool` (an agent's `carrying`) prefixes a small glyph when present. */
  show(text: string, tool?: string): void {
    this.isThinking = !text.trim();
    if (this.isThinking) {
      this.dotsElapsed = 0;
      this.dotsPhase = 0;
      this.label.text = '.';
    } else {
      const raw = tool ? `${toolIcon(tool)} ${text}` : text;
      // A styled bubble's pixel font has no emoji; a colour glyph in it reads as noise.
      const display = this.style ? stripEmoji(raw) || raw : raw;
      // Word-wrap (style.wordWrap) handles the horizontal fit, so the card can no
      // longer overflow; we only cap the raw length so a very long action wraps to
      // a few lines rather than a wall of text.
      this.label.text = display.length > MAX_CHARS
        ? display.slice(0, MAX_CHARS - 1).trimEnd() + '…'
        : display;
    }
    this.redraw();
    this.reveal();
  }

  private reveal(): void {
    if (this.state === 'hidden' || this.state === 'fading-out') {
      this.state = 'fading-in';
      this.fadeElapsed = 0;
      this.container.visible = true;
    } else {
      // already up — swap text in place without re-fading
      this.state = 'visible';
      this.container.alpha = 1;
    }
    this.lingerElapsed = 0;
  }

  /** Begin fading out (after a short linger) — call when the agent goes quiet. */
  startLinger(): void {
    if (this.state === 'hidden') return;
    this.state = 'lingering';
    this.lingerElapsed = 0;
  }

  /** Update for the camera zoom: keep the bubble's SCREEN size from dropping
   *  below 1:1 by counter-scaling while the world is zoomed out. */
  setZoom(z: number): void {
    if (!(z > 0) || z === this.zoom) return;
    this.zoom = z;
    this.container.scale.set(this.compensation());
  }

  /** World-units multiplier that cancels a < 1 camera zoom (1 at zoom ≥ 1). */
  private compensation(): number {
    return 1 / Math.min(this.zoom, 1);
  }

  /** The world rect the bubble must stay inside (the map size, in px). */
  setBounds(w: number, h: number): void {
    this.boundsW = w;
    this.boundsH = h;
  }

  setPosition(px: number, py: number): void {
    const comp = this.compensation();
    const w = this.bgW * RENDER_SCALE * comp;
    const h = this.bgH * RENDER_SCALE * comp;
    let x = px - w / 2;
    let y = py + this.offsetY() - h - this.extraLift;
    if (this.boundsW > 0) {
      // Clamp into the world, tooltip-style: slide horizontally, and a cloud
      // that would poke above the top edge slides down instead (it may then
      // cover the avatar's hat — better than being unreadable off-world).
      x = Math.min(Math.max(x, 1), Math.max(1, this.boundsW - w - 1));
      y = Math.min(Math.max(y, 1), Math.max(1, this.boundsH - h - 1));
    }
    this.container.x = Math.round(x);
    this.container.y = Math.round(y);
    const tailX = Math.round((px - this.container.x) / (RENDER_SCALE * comp));
    if (tailX !== this.tailX) {
      this.tailX = tailX;
      this.drawTail();
    }
  }

  private offsetY(): number {
    return this.style?.offsetY ?? OFFSET_Y;
  }

  /** Extra upward shift (px), set by the scene's bubble-overlap pass. */
  setLift(px: number): void {
    this.extraLift = px;
  }

  /** The bubble's base screen rect (ignoring any lift) for a given anchor, or
   *  null when hidden. Used by the scene to detect and resolve overlaps. */
  getLayout(px: number, py: number): { x: number; y: number; w: number; h: number } | null {
    if (this.state === 'hidden') return null;
    const comp = this.compensation();
    const w = this.bgW * RENDER_SCALE * comp;
    const h = this.bgH * RENDER_SCALE * comp;
    let x = px - w / 2;
    let y = py + this.offsetY() - h;
    if (this.boundsW > 0) {
      // Report the CLAMPED base rect so the overlap resolver stacks bubbles
      // where they actually render, not where they ideally would.
      x = Math.min(Math.max(x, 1), Math.max(1, this.boundsW - w - 1));
      y = Math.min(Math.max(y, 1), Math.max(1, this.boundsH - h - 1));
    }
    return { x, y, w, h };
  }

  hide(): void {
    this.state = 'hidden';
    this.isThinking = false;
    this.container.alpha = 0;
    this.container.visible = false;
  }

  isHidden(): boolean {
    return this.state === 'hidden';
  }

  update(dt: number): void {
    if (this.isThinking && (this.state === 'visible' || this.state === 'fading-in')) {
      this.dotsElapsed += dt;
      const newPhase = Math.floor(this.dotsElapsed / DOTS_CYCLE_SPEED) % 3;
      if (newPhase !== this.dotsPhase) {
        this.dotsPhase = newPhase;
        this.label.text = ['.', '..', '...'][this.dotsPhase];
        this.redraw();
      }
    }

    switch (this.state) {
      case 'fading-in': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_IN_DURATION, 1);
        this.container.alpha = t;
        if (t >= 1) this.state = 'visible';
        break;
      }
      case 'lingering': {
        this.lingerElapsed += dt;
        if (this.lingerElapsed >= LINGER_DURATION) {
          this.state = 'fading-out';
          this.fadeElapsed = 0;
        }
        break;
      }
      case 'fading-out': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_OUT_DURATION, 1);
        this.container.alpha = 1 - t;
        if (t >= 1) this.hide();
        break;
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private redraw(): void {
    // The cloud always wraps the MEASURED text. Clamping the bg to MAX_WIDTH
    // while the label keeps its real width let text paint past the bubble edge
    // whenever the measurement overshot wordWrapWidth a touch (emoji glyphs,
    // fallback-font metrics) — on the dark map that read as "horizontally cut".
    // wordWrap already bounds the label, so the bg needs no clamp of its own.
    const st = this.style;
    this.bgW = this.label.width + (st?.padX ?? PADDING_X) * 2;
    this.bgH = this.label.height + (st?.padY ?? PADDING_Y) * 2;

    this.bg.clear();
    if (this.frame) {
      this.frame.width = Math.max(this.bgW, st!.border * 2);
      this.frame.height = Math.max(this.bgH, st!.border * 2);
    } else {
      this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
      this.bg.fill({ color: FILL_COLOR });
      this.bg.stroke({ color: OUTLINE_COLOR, width: 1 });
    }

    this.drawTail();
  }

  /** Two shrinking puffs trailing down toward the avatar's head: the cue that
   *  says "thinking", not "speech". */
  private drawTail(): void {
    const st = this.style;
    this.tail.clear();
    const edge = 8;
    const baseX = this.tailX < 0
      ? this.bgW / 2
      : Math.min(Math.max(this.tailX, edge), Math.max(edge, this.bgW - edge));
    const puff = (cx: number, cy: number, r: number) => {
      this.tail.circle(cx, cy, r)
        .fill({ color: st?.puffFill ?? FILL_COLOR })
        .stroke({ color: st?.puffOutline ?? OUTLINE_COLOR, width: 1 });
    };
    puff(baseX, this.bgH + 4, 3);
    puff(baseX, this.bgH + 9, 2);
  }
}

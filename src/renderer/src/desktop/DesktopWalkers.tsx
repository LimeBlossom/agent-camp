/**
 * The least intrusive desktop look: no map at all, just each agent's character
 * pacing along the bottom edge of the strip. An idle agent strolls, pauses and
 * naps; a working one sits down facing out, its current action in a thought
 * bubble; one waiting on the human stands facing out with a bubble saying so.
 *
 * It reuses the floor's sprite and bubble classes but none of its map, paths
 * or scene props, so it is a separate Pixi app rather than a mode of OfficeFloor.
 */
import { useEffect, useRef } from 'react';
import { Application, Container, type Ticker } from 'pixi.js';
import { useStore, type Agent } from '@/store/store';
import { CharacterSprite, type AnimState, type Direction } from '@/scene/office/CharacterSprite';
import { ThoughtBubble } from '@/scene/office/ThoughtBubble';
import { setBubbleStyle } from '@/scene/office/bubbleStyle';
import { loadBubbleStyle, loadTheme } from '@/scene/office/themeLoader';

/** Stroll speed, in unscaled sprite pixels per second. */
const SPEED = 22;
const EDGE = 24;
const DEFAULT_PAUSE: [number, number] = [4, 12];
/** The bubble's offset above the feet at 1x (ThoughtBubble's OFFSET_Y). */
const BUBBLE_LIFT = 38;
/** The visible body inside a character's 96px PMD frame, around the feet. */
const BODY = { halfWidth: 16, height: 40 };

/** The strip height a given sprite scale needs: body, lifted bubble, headroom. */
export function stripHeightFor(scale: number): number {
  return Math.round(BUBBLE_LIFT * scale + 64);
}

export type ShapeRect = { x: number; y: number; width: number; height: number };

type Mode = 'stroll' | 'pause' | 'nap' | 'work' | 'wait';

interface Walker {
  sprite: CharacterSprite;
  bubble: ThoughtBubble;
  x: number;
  target: number;
  dir: Direction;
  mode: Mode;
  timer: number;
  bubbleText: string | null;
}

const SHAPE_SECONDS = 0.1;

const rand = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);

export function DesktopWalkers({ scale, onShape, onPick }: {
  /** Integer upscale of the sprites. */
  scale: number;
  /** The rects the characters and their bubbles cover, in CSS px, a few times a second. */
  onShape: (rects: ShapeRect[]) => void;
  onPick: (agentId: string) => void;
}) {
  const onShapeRef = useRef(onShape);
  const onPickRef = useRef(onPick);
  onShapeRef.current = onShape;
  onPickRef.current = onPick;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const officeTheme = useStore((s) => s.officeTheme);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    const app = new Application();
    const walkers = new Map<string, Walker>();
    const loading = new Set<string>();
    let unsub = () => { /* set once the scene is up */ };

    const init = async () => {
      const theme = await loadTheme(officeTheme);
      setBubbleStyle(await loadBubbleStyle(theme));
      await app.init({
        backgroundAlpha: 0,
        antialias: false,
        roundPixels: true,
        resolution: Math.max(window.devicePixelRatio || 1, 1),
        autoDensity: true,
        resizeTo: host,
      });
      if (dead) { app.destroy(true); return; }
      host.appendChild(app.canvas);

      const world = new Container();
      world.scale.set(scale);
      const bubbles = new Container();
      app.stage.addChild(world, bubbles);

      const cast = theme.cast;
      const idle = cast.spriteStyle?.idleBehaviour;
      const widthPx = () => app.screen.width / scale;
      const groundY = () => app.screen.height / scale - 2;

      const add = async (agent: Agent) => {
        if (walkers.has(agent.id) || loading.has(agent.id)) return;
        loading.add(agent.id);
        const name = agent.isGod ? cast.bossCharacter
          : cast.byName[agent.character] ? agent.character : cast.defaultCharacter;
        const frames = await cast.getFrames(name);
        loading.delete(agent.id);
        if (dead || walkers.has(agent.id)) return;
        if (!useStore.getState().agents.some((a) => a.id === agent.id)) return;
        const sprite = new CharacterSprite(frames, cast.spriteStyle);
        sprite.container.eventMode = 'static';
        sprite.container.cursor = 'pointer';
        sprite.container.on('pointertap', () => onPickRef.current(agent.id));
        const bubble = new ThoughtBubble();
        bubble.hide();
        world.addChild(sprite.container);
        bubbles.addChild(bubble.container);
        const x = EDGE + Math.random() * Math.max(1, widthPx() - 2 * EDGE);
        walkers.set(agent.id, {
          sprite, bubble, x, target: x, dir: Math.random() < 0.5 ? 'left' : 'right',
          mode: 'pause', timer: rand([0, 3]), bubbleText: null,
        });
      };

      const sync = () => {
        const live = useStore.getState().agents.filter((a) => a.status !== 'ghost');
        const ids = new Set(live.map((a) => a.id));
        for (const [id, w] of walkers) {
          if (ids.has(id)) continue;
          w.sprite.destroy();
          w.bubble.destroy();
          walkers.delete(id);
        }
        for (const a of live) void add(a);
      };
      sync();
      unsub = useStore.subscribe((s, prev) => { if (s.agents !== prev.agents) sync(); });

      const say = (w: Walker, text: string | null) => {
        if (text === w.bubbleText) return;
        w.bubbleText = text;
        if (text === null) w.bubble.startLinger();
        else w.bubble.show(text);
      };

      const tick = (ticker: Ticker) => {
        const dt = ticker.deltaMS / 1000;
        const agents = new Map(useStore.getState().agents.map((a) => [a.id, a]));
        const maxX = Math.max(EDGE + 1, widthPx() - EDGE);
        for (const [id, w] of walkers) {
          const agent = agents.get(id);
          if (!agent) continue;
          const busy = agent.status === 'working' || agent.status === 'thinking';
          const needsYou = agent.status === 'blocked' || agent.status === 'waiting';

          let anim: AnimState = 'idle';
          if (busy) {
            w.mode = 'work';
            w.dir = 'down';
            anim = w.sprite.hasAnim('sit') ? 'sit' : 'idle';
            say(w, agent.status === 'thinking' ? '' : agent.action || '');
          } else if (needsYou) {
            w.mode = 'wait';
            w.dir = 'down';
            say(w, 'needs you');
          } else {
            if (w.mode === 'work' || w.mode === 'wait') { w.mode = 'pause'; w.timer = rand([1, 3]); }
            say(w, null);
            w.timer -= dt;
            if (w.mode === 'stroll') {
              const step = SPEED * dt;
              const gap = w.target - w.x;
              if (Math.abs(gap) <= step) {
                w.x = w.target;
                const nap = idle && Math.random() < idle.napChance;
                w.mode = nap ? 'nap' : 'pause';
                w.timer = nap ? rand(idle.napSeconds) : rand(idle?.pauseSeconds ?? DEFAULT_PAUSE);
              } else {
                w.x += Math.sign(gap) * step;
                w.dir = gap < 0 ? 'left' : 'right';
                anim = 'walk';
              }
            } else if (w.timer <= 0) {
              w.mode = 'stroll';
              w.target = EDGE + Math.random() * (maxX - EDGE);
            }
            if (w.mode === 'nap' && w.sprite.hasAnim('nap')) anim = 'nap';
          }

          w.x = Math.min(Math.max(w.x, EDGE), maxX);
          w.sprite.setAnimation(anim, w.dir);
          w.sprite.setPosition(w.x, groundY());
          w.bubble.setBounds(app.screen.width, app.screen.height);
          w.bubble.setPosition(w.x * scale, groundY() * scale - BUBBLE_LIFT * (scale - 1));
          w.bubble.update(dt);
        }

        shapeClock -= dt;
        if (shapeClock <= 0) {
          shapeClock = SHAPE_SECONDS;
          const rects: ShapeRect[] = [];
          for (const w of walkers.values()) {
            const feetY = groundY() * scale;
            rects.push({ x: w.x * scale - BODY.halfWidth * scale, y: feetY - BODY.height * scale,
              width: BODY.halfWidth * 2 * scale, height: BODY.height * scale + 2 });
            if (w.bubble.container.visible) {
              const b = w.bubble.container.getBounds();
              rects.push({ x: b.x - 2, y: b.y - 2, width: b.width + 4, height: b.height + 4 });
            }
          }
          onShapeRef.current(rects);
        }
      };
      let shapeClock = 0;
      app.ticker.add(tick);
    };
    void init();

    return () => {
      dead = true;
      unsub();
      for (const w of walkers.values()) { w.sprite.destroy(); w.bubble.destroy(); }
      walkers.clear();
      try { app.destroy(true, { children: true }); } catch { /* init never finished */ }
    };
  }, [officeTheme, scale]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', imageRendering: 'pixelated' }} />;
}

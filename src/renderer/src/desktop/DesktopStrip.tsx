/**
 * The desktop-mode strip: the agents' characters pacing along the bottom of
 * the screen, and a row of controls. It watches the task board and pops the
 * ASK ME window up when a new question arrives, and tells main which parts of
 * the strip are solid so everything else clicks through to the desktop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { parse } from '@/components/AskMeTab';
import { waitsOnHuman } from '@/components/TasksKanban';
import { useDesktopMirror } from './mirror';
import { DesktopWalkers, stripHeightFor, type ShapeRect } from './DesktopWalkers';

const POLL_MS = 5000;
/** Sprite scales `↕` steps through. */
const SCALES = [2, 3, 1];

export function DesktopStrip() {
  useDesktopMirror();
  const [waiting, setWaiting] = useState(0);
  const [askOpen, setAskOpen] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);
  const [scale, setScale] = useState(SCALES[0]);
  const godId = useStore((s) => s.agents.find((a) => a.isGod)?.id);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const lastShape = useRef('');

  const showAsk = (show: boolean) => { void window.cth.desktopAskMe(show); };

  useEffect(() => window.cth.onDesktopPopup(({ which, shown }) => {
    if (which === 'askme') setAskOpen(shown); else setTalkOpen(shown);
  }), []);

  useEffect(() => { void window.cth.desktopSetHeight(stripHeightFor(scale)); }, [scale]);

  const onShape = useCallback((rects: ShapeRect[]) => {
    const c = controlsRef.current?.getBoundingClientRect();
    const all = c ? [...rects, { x: c.x - 2, y: c.y - 2, width: c.width + 4, height: c.height + 4 }] : rects;
    const key = JSON.stringify(all.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]));
    if (key === lastShape.current) return;
    lastShape.current = key;
    window.cth.desktopShape(all);
  }, []);

  useEffect(() => {
    const poll = async () => {
      let open: number;
      try {
        open = parse(await window.cth.hiveTasks()).filter(waitsOnHuman).length;
      } catch { return; }
      // Never opens on its own (The human): the coral count on the ? button is the signal.
      setWaiting(open);
      if (open === 0) showAsk(false);
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <DesktopWalkers scale={scale} onShape={onShape} onPick={(id) => void window.cth.desktopTalk(id)} />
      <div className="cth-desktop-controls" ref={controlsRef}>
        <button className="cth-desktop-btn" title={talkOpen ? 'Close chat' : 'Talk to the orchestrator'}
          disabled={!godId && !talkOpen}
          onClick={() => void window.cth.desktopTalk(talkOpen ? null : godId ?? null)}>
          Talk
        </button>
        <button className="cth-desktop-btn" onClick={() => showAsk(!askOpen)}
          title={askOpen ? 'Hide Ask Me' : 'Show Ask Me'}
          style={waiting > 0 ? { background: 'var(--cth-coral)', color: 'var(--cth-paper-100)' } : undefined}>
          ? {waiting > 0 ? waiting : ''}
        </button>
        <button className="cth-desktop-btn" title="Change character size"
          onClick={() => setScale((s) => SCALES[(SCALES.indexOf(s) + 1) % SCALES.length])}>
          ↕
        </button>
        <button className="cth-desktop-btn" onClick={() => void window.cth.desktopExit()} title="Back to window mode">
          ▣
        </button>
      </div>
    </div>
  );
}

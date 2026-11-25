import { useEffect, useState } from 'react';
import { MEDIA_NOTICE_EVENT } from './openMedia';

const NOTICE_MS = 4000;

/** One-line notice for an image or video that failed to open externally. Mounted once in App. */
export function MediaNotice() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setText(null), NOTICE_MS);
    };
    window.addEventListener(MEDIA_NOTICE_EVENT, on);
    return () => { window.removeEventListener(MEDIA_NOTICE_EVENT, on); clearTimeout(timer); };
  }, []);
  if (!text) return null;
  return (
    <div role="status" onClick={() => setText(null)} style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 10000,
      maxWidth: '80vw', padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
      background: 'var(--cth-ink-900, #222)', color: 'var(--cth-paper-100, #fff)', fontSize: 13
    }}>{text}</div>
  );
}

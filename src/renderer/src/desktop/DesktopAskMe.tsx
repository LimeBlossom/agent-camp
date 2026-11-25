/** The desktop-mode ASK ME pop-up: the ordinary board in a borderless card. */
import { AskMeTab } from '@/components/AskMeTab';
import { useDesktopMirror } from './mirror';
import { MediaNotice } from '@/media/MediaNotice';

export function DesktopAskMe() {
  useDesktopMirror();
  return (
    <div className="cth-desktop-card">
      <div className="cth-desktop-card-bar">
        <span>ASK ME</span>
        <button className="cth-desktop-btn" onClick={() => void window.cth.desktopAskMe(false)} title="Hide">✕</button>
      </div>
      <AskMeTab />
      <MediaNotice />
    </div>
  );
}

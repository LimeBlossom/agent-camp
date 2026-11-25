/**
 * The desktop-mode chat pop-up: one agent's last reply, and a box to message
 * it. Opened from the strip's 💬 (the orchestrator) or by clicking a character.
 * The message goes to the primary window, which enqueues it exactly as its own
 * composer would, so delivery waits for the agent to be idle the same way.
 */
import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { isComposingKey } from '@shared/imeGuard';
import { useDesktopMirror } from './mirror';

export function DesktopTalk() {
  useDesktopMirror();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));

  useEffect(() => {
    void window.cth.desktopGetTalkTarget().then((id) => { if (id) setAgentId(id); });
    return window.cth.onDesktopTalkTarget((id) => { setAgentId(id); setSent(false); });
  }, []);

  const send = async () => {
    const body = text.trim();
    if (!body || !agentId) return;
    if (await window.cth.desktopSend(agentId, body)) {
      setText('');
      setSent(true);
    }
  };

  const busy = agent?.status === 'working' || agent?.status === 'thinking';
  return (
    <div className="cth-desktop-card">
      <div className="cth-desktop-card-bar">
        <span>{agent ? agent.name : '…'}{agent && busy ? ` · ${agent.action || 'working'}` : ''}</span>
        <button className="cth-desktop-btn" onClick={() => void window.cth.desktopTalk(null)} title="Close">✕</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, fontFamily: 'var(--cth-font-mono)', fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)' }}>
        {agent?.recentAssistantText
          ? <MarkdownPreview source={agent.recentAssistantText} variant="card" />
          : <span style={{ color: 'var(--cth-ink-500)' }}>No reply yet this session. It shows here when {agent?.name ?? 'the agent'} next finishes a turn.</span>}
      </div>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4, boxShadow: 'inset 0 1px 0 var(--cth-ink-300)' }}>
        {sent && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>Sent. {agent?.name ?? 'The agent'} gets it once it is idle.</span>}
        <textarea
          autoFocus
          value={text}
          onChange={(e) => { setText(e.target.value); setSent(false); }}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder={`Message ${agent?.name ?? ''}… (Enter to send, Shift+Enter for a new line)`}
          rows={3}
          style={{ resize: 'none', fontFamily: 'var(--cth-font-mono)', fontSize: 15, padding: 6, background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', borderRadius: 2 }}
        />
      </div>
    </div>
  );
}

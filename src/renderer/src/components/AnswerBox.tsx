import type { ReactNode } from 'react';
import { PixelButton } from './PixelButton';
import { isComposingKey } from '@shared/imeGuard';
import { useRtl } from '@/i18n/useDirection';

/** The reply box under an ASK ME question or a Results entry: a textarea that sends on
 *  Ctrl/Cmd+Enter, the send button, and any extra controls after it in the same row. */
export function AnswerBox({ value, onChange, onSend, busy, placeholder, sendLabel, busyLabel, autoFocus, children }: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  busy: boolean;
  placeholder: string;
  sendLabel: string;
  busyLabel: string;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  const rtl = useRtl();
  return (
    <>
      <textarea
        dir={rtl ? 'auto' : undefined}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend(); }}
        rows={3}
        placeholder={placeholder}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
          background: 'var(--cth-paper-100)', border: 'none',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontFamily: 'var(--cth-font-mono)', fontSize: 15, lineHeight: '18px',
          color: 'var(--cth-ink-900)', outline: 'none'
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PixelButton variant="primary" size="sm" disabled={!value.trim() || busy} onClick={onSend}>
          {busy ? busyLabel : sendLabel}
        </PixelButton>
        {children}
      </div>
    </>
  );
}

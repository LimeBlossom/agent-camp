import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { noteKeyAction } from '@shared/snip';
import { PixelButton } from '@/components/PixelButton';

/** The note for a snip: Enter files the card for the boss, Shift+Enter is a new line, Esc discards. */
export function SnipNote() {
  const { t } = useTranslation();
  const [init, setInit] = useState<{ image: string; app: string } | null>(null);
  const [text, setText] = useState('');

  useEffect(() => { void window.cth.snipNoteInit().then(setInit); }, []);

  const submit = (): void => window.cth.snipNoteSubmit(text);
  const discard = (): void => window.cth.snipNoteDiscard();

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: 12, height: '100vh', boxSizing: 'border-box',
      background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)'
    }}>
      {init && (
        <img src={init.image} alt="" style={{
          alignSelf: 'center', maxWidth: '100%', maxHeight: 200, objectFit: 'contain',
          boxShadow: '0 0 0 1px var(--cth-ink-300)'
        }} />
      )}
      {init && (
        <div title={init.app} style={{ fontSize: 12, color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {init.app}
        </div>
      )}
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const action = noteKeyAction(e);
          if (!action) return;
          e.preventDefault();
          if (action === 'submit') submit();
          else discard();
        }}
        style={{
          flex: 1, resize: 'none', padding: 8, fontFamily: 'var(--cth-font-mono)', fontSize: 13, lineHeight: '18px',
          background: 'var(--cth-paper-50, #fff)', color: 'var(--cth-ink-900)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <PixelButton variant="secondary" size="sm" onClick={discard}>{t('snip.discard')}</PixelButton>
        <PixelButton variant="primary" size="sm" onClick={submit}>{t('snip.file')}</PixelButton>
      </div>
    </div>
  );
}

import { Terminal } from '@xterm/headless';
import { agyRefusal, type AgyRefusal } from './providerLimits';

/** One renderer per PTY, preserving split escape sequences and cursor redraws. */
export class AgyRefusalTerminal {
  private terminal = new Terminal({ cols: 200, rows: 60, scrollback: 100, allowProposedApi: true });
  write(data: string, seen: (refusal: AgyRefusal | null) => void): void {
    this.terminal.write(data, () => {
      const buffer = this.terminal.buffer.active;
      let text = '';
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        text += (line.isWrapped ? '' : '\n') + line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
      }
      seen(agyRefusal(text.trimEnd()));
    });
  }
  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && (this.terminal.cols !== cols || this.terminal.rows !== rows)) this.terminal.resize(cols, rows);
  }
  dispose(): void { this.terminal.dispose(); }
}

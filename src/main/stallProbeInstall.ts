// Imported first by index.ts so every ipcMain.handle and timer registered after it is timed.
import { ipcMain } from 'electron';
import { StallProbe, type StallReport } from './stallProbe';

const early: StallReport[] = [];
let sink: ((r: StallReport) => void) | null = null;

export const stallProbe = new StallProbe((r) => {
  if (sink) sink(r);
  else if (early.length < 50) early.push(r);
});
stallProbe.install(ipcMain);

/** Where reports go once the hive log exists; flushes the ones taken during startup. */
export function setStallSink(fn: (r: StallReport) => void): void {
  sink = fn;
  for (const r of early.splice(0)) fn(r);
}

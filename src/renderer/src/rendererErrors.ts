import { RENDERER_ERROR_PREFIX } from '../../shared/rendererLog';
import { createRateLimitedReporter } from './scene/office/tickIsolation';

/** Send uncaught errors and unhandled rejections to the console under the prefix
 *  main keeps in renderer.log, rate-limited per message so a per-frame throw does
 *  not flood the file. */
export function installRendererErrorForwarding(
  target: EventTarget,
  log: (line: string) => void = (line) => console.error(line),
): void {
  const report = createRateLimitedReporter(log, { prefix: RENDERER_ERROR_PREFIX });
  target.addEventListener('error', (e) => {
    const ev = e as ErrorEvent;
    report(`uncaught ${ev.message ?? ''}`.trim(), ev.error ?? ev.message);
  });
  target.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    report(`unhandled rejection ${reason instanceof Error ? reason.message : String(reason)}`, reason);
  });
}

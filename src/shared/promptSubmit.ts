/**
 * Watches for the UserPromptSubmit hook that proves a typed prompt was really
 * submitted. Writing "\r" to the pty is not proof: when the TUI is still
 * ingesting the text as a paste, the Enter lands as a newline in the input box
 * and the message sits there unsent while the queue counts it delivered.
 *
 * `arm` must be called BEFORE the Enter is written, so a hook that beats the
 * caller to `wait` is not missed.
 */
export function createPromptSubmitWatch(): {
  arm: (agentId: string) => (timeoutMs: number) => Promise<boolean>;
  notify: (agentId: string) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    arm(agentId) {
      let seen = false;
      let wake: (() => void) | null = null;
      const onSubmit = (): void => { seen = true; wake?.(); };
      const set = listeners.get(agentId) ?? new Set();
      set.add(onSubmit);
      listeners.set(agentId, set);
      const disarm = (): void => {
        set.delete(onSubmit);
        if (!set.size) listeners.delete(agentId);
      };
      return (timeoutMs) => new Promise<boolean>((resolve) => {
        if (seen) { disarm(); resolve(true); return; }
        const timer = setTimeout(() => { disarm(); resolve(false); }, timeoutMs);
        wake = () => { clearTimeout(timer); disarm(); resolve(true); };
      });
    },
    notify(agentId) {
      for (const fn of [...(listeners.get(agentId) ?? [])]) fn();
    }
  };
}

/** How long to wait for the first Enter's UserPromptSubmit before pressing again. */
export const SUBMIT_CONFIRM_MS = 4000;

/** Enters after the first, and the longest wait between them. A fresh Claude TUI can
 *  swallow an Enter while it is still loading hooks and MCP servers, so one retry at
 *  4s is not enough; each wait doubles up to the cap (about a minute in all). */
export const SUBMIT_EXTRA_PRESSES = 4;
export const SUBMIT_MAX_WAIT_MS = 30_000;

/**
 * Press Enter, and press it again, waiting longer each time, until a submit is
 * confirmed. Returns whether one was. An unconfirmed result is NOT a failed delivery:
 * the text is already in the input box, so retyping it would duplicate it, and an
 * agent whose hook channel is down would otherwise never receive anything. An Enter
 * on an empty prompt does nothing, so the retries are safe once the prompt went in.
 */
export async function pressEnterUntilSubmitted(
  pressEnter: () => Promise<void>,
  armSubmitWait: () => (timeoutMs: number) => Promise<boolean>,
  timeoutMs: number,
  extraPresses = SUBMIT_EXTRA_PRESSES,
  maxWaitMs = SUBMIT_MAX_WAIT_MS
): Promise<boolean> {
  let wait = timeoutMs;
  for (let press = 0; press <= extraPresses; press++) {
    const waitForSubmit = armSubmitWait();
    try {
      await pressEnter();
    } catch (err) {
      void waitForSubmit(0);
      throw err;
    }
    if (await waitForSubmit(wait)) return true;
    wait = Math.min(wait * 2, maxWaitMs);
  }
  return false;
}

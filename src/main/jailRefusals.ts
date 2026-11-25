/** Sandboxed agents the jail last refused to spawn, so the fleet row and standup show
 *  them as down; a later successful spawn clears the entry. A permanent refusal (a
 *  provider the jail cannot run) also holds automatic wakes, so it never respawn-loops. */
export interface JailRefusal { error: string; at: number; permanent?: boolean; card?: string }

export class JailRefusals {
  private readonly byId = new Map<string, JailRefusal>();

  /** `notify` is true only for a permanent refusal that differs from the one already held. */
  refused(id: string, error: string, at: number, opts: { permanent?: boolean; card?: string } = {}): { notify: boolean } {
    const prev = this.byId.get(id);
    const permanent = opts.permanent === true;
    const notify = permanent && !(prev?.permanent && prev.error === error && prev.card === opts.card);
    this.byId.set(id, { error, at, ...(permanent ? { permanent } : {}), ...(opts.card ? { card: opts.card } : {}) });
    return { notify };
  }

  spawned(id: string): void { this.byId.delete(id); }

  /** A Boss wake request: try again, and report again if it still fails. */
  release(id: string): void { this.byId.delete(id); }

  /** Automatic wakes wait while a permanent refusal's card is still next (or it had none). */
  held(id: string, nextCard: string | undefined): boolean {
    const r = this.byId.get(id);
    return !!r?.permanent && (!r.card || r.card === nextCard);
  }

  get(id: string): JailRefusal | null { return this.byId.get(id) ?? null; }
}

export function jailRefusalNotice(name: string, agentId: string, error: string, card: string | undefined): { subject: string; body: string } {
  return {
    subject: `[agent sandbox] ${name} cannot start`,
    body: [
      `The agent sandbox refused to start ${name} (${agentId}): ${error}.`,
      card
        ? `Card ${card} was set blocked, since no engine on its model ladder can run in the sandbox.`
        : 'It has no open card to block.',
      'Automatic wakes are held. Fix the model ladder, reservations or pin (or take the agent out of sandboxedAgents), then send it a wake request.'
    ].join(' ')
  };
}

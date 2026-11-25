export interface BossInboxNudgeConfig {
  quietMs: number;
  maxWaitMs: number;
  immediateSenders: string[];
  immediateActs: string[];
  passiveActs: string[];
}

export const DEFAULT_BOSS_INBOX_NUDGE: BossInboxNudgeConfig = {
  quietMs: 180_000,
  maxWaitMs: 600_000,
  immediateSenders: ['human'],
  immediateActs: ['request', 'query'],
  passiveActs: ['inform']
};

type Mail = { id: string; from: string; act: string };

/** Tracks receipt times, not message timestamps: externally supplied dates need not be trustworthy. */
export class BossInboxBatch {
  private arrived = new Map<string, number>();
  private delivered = new Set<string>();

  /** `closing`: the floor is shutting down and the Boss waits on WRAP-UP-ACKs, so nothing is batched. */
  inspect(inbox: Mail[], now: number, config?: Partial<BossInboxNudgeConfig>, opts?: { closing?: boolean }): { due: boolean; ids: string[] } {
    const cfg = { ...DEFAULT_BOSS_INBOX_NUDGE, ...config };
    const fresh = inbox.filter((m) => m.id && !this.delivered.has(m.id));
    const present = new Set(fresh.map((m) => m.id));
    for (const id of this.arrived.keys()) if (!present.has(id)) this.arrived.delete(id);
    for (const m of fresh) if (!this.arrived.has(m.id)) this.arrived.set(m.id, now);
    const immediate = (m: Mail): boolean => opts?.closing === true || cfg.immediateSenders.includes(m.from) || cfg.immediateActs.includes(m.act);
    const eligible = fresh.filter((m) => immediate(m) || !cfg.passiveActs.includes(m.act));
    if (!eligible.length) return { due: false, ids: [] };
    const times = eligible.map((m) => this.arrived.get(m.id)!);
    const duration = (v: number, fallback: number): number => Number.isFinite(v) && v >= 0 ? v : fallback;
    const due = eligible.some(immediate)
      || now >= Math.min(
        Math.max(...times) + duration(cfg.quietMs, DEFAULT_BOSS_INBOX_NUDGE.quietMs),
        Math.min(...times) + duration(cfg.maxWaitMs, DEFAULT_BOSS_INBOX_NUDGE.maxWaitMs)
      );
    return { due, ids: fresh.map((m) => m.id) };
  }

  acknowledge(ids: string[]): void {
    for (const id of ids) {
      this.delivered.add(id);
      this.arrived.delete(id);
    }
  }
}

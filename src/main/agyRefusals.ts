import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hitUntil, type LimitHit, type AgyRefusal } from './providerLimits';

export interface ModelRefusal extends LimitHit {
  agentId: string;
  model: string;
  errorId: string;
  source: 'server' | 'terminal';
  seenAtMs: number;
}

export function modelKey(model: string): string {
  return model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function noticeKey(r: ModelRefusal): string {
  return createHash('sha256').update(`${r.agentId}:${r.model}:${r.errorId}`).digest('hex').slice(0, 24);
}

/** Stores only refusal metadata. Never stores step payloads, prompts or account headers. */
export class AgyRefusalStore {
  private records = new Map<string, ModelRefusal>();
  private notices = new Set<string>();
  private path: string | null = null;

  load(path: string): void {
    if (this.path === path) return;
    this.path = path;
    this.records.clear(); this.notices.clear();
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    for (const r of data.records ?? []) {
      if (typeof r.agentId === 'string' && typeof r.model === 'string' && typeof r.errorId === 'string'
        && Number.isFinite(r.atMs) && Number.isFinite(r.resetAtMs) && Number.isFinite(r.seenAtMs)
        && (r.source === 'server' || r.source === 'terminal')) this.records.set(noticeKey(r), r);
    }
    for (const key of data.notices ?? []) if (typeof key === 'string') this.notices.add(key);
  }

  private save(): void {
    if (!this.path) return;
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, records: [...this.records.values()], notices: [...this.notices] }) + '\n', { mode: 0o600 });
    renameSync(temp, this.path);
  }

  record(r: ModelRefusal): ModelRefusal {
    r = { ...r, model: modelKey(r.model), message: 'Individual quota reached.' };
    const key = noticeKey(r);
    const prev = this.records.get(key);
    let removed = false;
    if (r.source === 'server') {
      for (const [oldKey, old] of this.records) if (oldKey !== key && old.source === 'terminal' && old.agentId === r.agentId
        && old.model === r.model && (old.errorId.startsWith('terminal-') || r.errorId.startsWith(old.errorId))) {
        this.records.delete(oldKey); removed = true;
      }
    }
    // An absolute server timestamp may refine a terminal estimate, never vice versa.
    if (prev && (prev.source === 'server' || r.source !== 'server')) { if (removed) this.save(); return prev; }
    const next = prev ? { ...r, seenAtMs: prev.seenAtMs } : r;
    this.records.set(key, next); this.save();
    return next;
  }

  terminal(agentId: string, model: string, r: AgyRefusal, now: number): ModelRefusal {
    const known = this.active(model, now);
    if (known?.source === 'server' && (!r.errorId || r.errorId === known.errorId)) return known;
    // Before Error ID arrives, use a stable fallback; a later ID inherits its anchor.
    const same = [...this.records.values()].find((v) => v.agentId === agentId && v.model === modelKey(model) && v.errorId === r.errorId);
    if (same) return same;
    const fallback = [...this.records.values()].find((v) => v.agentId === agentId && v.model === modelKey(model)
      && v.source === 'terminal' && v.errorId.startsWith('terminal-'));
    if (!r.errorId && fallback) return fallback;
    return this.record({ agentId, model, errorId: r.errorId ?? fallback?.errorId ?? `terminal-${createHash('sha256').update(r.message).digest('hex').slice(0, 16)}`,
      source: 'terminal', atMs: fallback?.atMs ?? now, seenAtMs: now,
      resetAtMs: fallback?.resetAtMs ?? now + (r.resetInMs ?? 3_600_000), message: r.message });
  }

  active(model: string | undefined, now: number): ModelRefusal | undefined {
    if (!model) return undefined;
    return [...this.records.values()].filter((r) => r.model === modelKey(model) && hitUntil(r) > now)
      .sort((a, b) => b.atMs - a.atMs)[0];
  }

  forAgent(agentId: string, model: string | undefined, now: number): ModelRefusal | undefined {
    return [...this.records.values()].filter((r) => r.agentId === agentId && (!model || r.model === modelKey(model)) && hitUntil(r) > now)
      .sort((a, b) => b.atMs - a.atMs)[0];
  }

  pendingNotices(): ModelRefusal[] {
    return [...this.records.values()].filter((r) => !this.notices.has(`${noticeKey(r)}:${r.source}`));
  }

  markNotified(r: ModelRefusal): void { this.notices.add(`${noticeKey(r)}:${r.source}`); this.save(); }
}

export function protoFields(b: Uint8Array): Map<number, Array<number | Uint8Array>> {
  const out = new Map<number, Array<number | Uint8Array>>();
  let i = 0;
  const read = (): number => {
    let value = 0, mul = 1;
    for (let n = 0; n < 10 && i < b.length; n++) {
      const x = b[i++]; value += (x & 127) * mul;
      if (!(x & 128)) return value;
      mul *= 128;
    }
    throw new Error('invalid varint');
  };
  while (i < b.length) {
    const key = read(), field = Math.floor(key / 8), wire = key & 7;
    let value: number | Uint8Array;
    if (wire === 0) value = read();
    else if (wire === 2) { const len = read(); if (i + len > b.length) throw new Error('truncated'); value = b.subarray(i, i + len); i += len; }
    else if (wire === 1 || wire === 5) { i += wire === 1 ? 8 : 4; continue; }
    else throw new Error('unsupported wire');
    const values = out.get(field) ?? []; values.push(value); out.set(field, values);
  }
  return out;
}

/** steps payload 24.3 contains the refusal; field 5 is Google's structured error JSON. */
export function refusalFromStep(agentId: string, metadata: Uint8Array, payload: Uint8Array, seenAtMs: number): ModelRefusal | null {
  try {
    const bytes = (fields: ReturnType<typeof protoFields>, key: number): Uint8Array => {
      const b = fields.get(key)?.[0]; if (!(b instanceof Uint8Array)) throw new Error('missing field'); return b;
    };
    const error = protoFields(bytes(protoFields(bytes(protoFields(payload), 24)), 3));
    const json = JSON.parse(Buffer.from(bytes(error, 5)).toString('utf8'));
    if (json.error?.code !== 429 || json.error?.status !== 'RESOURCE_EXHAUSTED') return null;
    const detail = json.error.details?.find((d: { reason?: string }) => d.reason === 'QUOTA_EXHAUSTED');
    const model = detail?.metadata?.model;
    const resetAtMs = Date.parse(detail?.metadata?.quotaResetTimeStamp);
    const stamp = protoFields(bytes(protoFields(metadata), 1));
    const sec = stamp.get(1)?.[0], nanos = stamp.get(2)?.[0] ?? 0;
    const errorId = Buffer.from(bytes(error, 6)).toString('utf8');
    if (typeof model !== 'string' || !Number.isFinite(resetAtMs) || typeof sec !== 'number' || typeof nanos !== 'number'
      || !/^[a-f0-9-]+$/i.test(errorId)) return null;
    return { agentId, model: modelKey(model), errorId, atMs: sec * 1000 + nanos / 1e6, resetAtMs,
      source: 'server', seenAtMs, message: 'Individual quota reached.' };
  } catch { return null; }
}

import { isWorkKind, type WorkKind } from './workKind';

/** A stretch of time an engine's quota is kept for some kinds of work (config.json `reservations`). */
export interface Reservation {
  provider: string;
  /** Only this model of the provider; absent covers the whole provider. */
  model?: string;
  kinds: WorkKind[];
  /** ISO time the reservation ends. */
  until: string;
  note?: string;
}

export interface ReservableEntry { provider: string; model?: string }

export interface ReservationResult<T> {
  list: T[];
  /** `order[i]` is the index of `list[i]` in the input. */
  order: number[];
  /** One line per reservation that excluded or preferred something. */
  notes: string[];
  /** Set when the input was non-empty and every entry was reserved away. */
  blocked?: string;
}

/** The valid reservations in a config value; a malformed one is dropped and an unknown
 *  kind is ignored, so a typo reserves the engine for fewer kinds rather than more. */
export function parseReservations(raw: unknown): Reservation[] {
  if (!Array.isArray(raw)) return [];
  const out: Reservation[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.provider !== 'string' || !o.provider || typeof o.until !== 'string' || !Number.isFinite(Date.parse(o.until))) continue;
    out.push({
      provider: o.provider,
      ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
      kinds: Array.isArray(o.kinds) ? o.kinds.filter(isWorkKind) : [],
      until: o.until,
      ...(typeof o.note === 'string' && o.note ? { note: o.note } : {})
    });
  }
  return out;
}

const untilMs = (r: Reservation): number => Date.parse(r.until);

export function isReservationActive(r: Reservation, nowMs: number): boolean {
  return nowMs < untilMs(r);
}

export function expiredReservations(list: readonly Reservation[], nowMs: number): Reservation[] {
  return list.filter((r) => !isReservationActive(r, nowMs));
}

/** Identity of one reservation across restarts. */
export function reservationKey(r: Reservation): string {
  return `${r.provider}|${r.model ?? ''}|${r.until}`;
}

export function reservationCovers(r: Reservation, e: ReservableEntry): boolean {
  return r.provider === e.provider && (r.model === undefined || r.model === e.model);
}

/** `codex reserved until 2026-11-26 for splat, visual (note)`, or `codex:model ...` when model-specific. */
export function describeReservation(r: Reservation): string {
  const target = r.model ? `${r.provider}:${r.model}` : r.provider;
  const kinds = r.kinds.length ? r.kinds.join(', ') : 'no work kind';
  return `${target} reserved until ${r.until.slice(0, 10)} for ${kinds}${r.note ? ` (${r.note})` : ''}`;
}

/**
 * Applies the active reservations to an ordered list of engines for work of `kind`.
 * A reserved entry is dropped unless `kind` is one of that reservation's kinds; an absent
 * kind never matches. Entries the kind is reserved for move to the front, order otherwise
 * stable. When nothing survives, `blocked` names the reservations instead of letting the
 * caller fall back onto the reserved engine.
 */
export function applyReservations<T>(
  entries: readonly T[],
  reservations: readonly Reservation[],
  kind: WorkKind | undefined,
  nowMs: number,
  entryOf: (item: T) => ReservableEntry = (item) => item as unknown as ReservableEntry
): ReservationResult<T> {
  const active = reservations.filter((r) => isReservationActive(r, nowMs));
  const kept: number[] = [];
  const preferred: number[] = [];
  const notes = new Set<string>();
  entries.forEach((item, i) => {
    const e = entryOf(item);
    const covering = active.filter((r) => reservationCovers(r, e));
    const closed = covering.filter((r) => kind === undefined || !r.kinds.includes(kind));
    if (closed.length) {
      closed.forEach((r) => notes.add(`${describeReservation(r)}: excluded`));
      return;
    }
    if (covering.length) {
      covering.forEach((r) => notes.add(`${describeReservation(r)}: preferred for ${kind} work`));
      preferred.push(i);
    } else kept.push(i);
  });
  const order = [...preferred, ...kept];
  const blocked = entries.length && !order.length
    ? `every engine is reserved: ${[...notes].map((n) => n.replace(/: excluded$/, '')).join('; ')}`
    : undefined;
  return { list: order.map((i) => entries[i]), order, notes: [...notes], ...(blocked ? { blocked } : {}) };
}

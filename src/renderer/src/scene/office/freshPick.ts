// Picks a line from a pool while steering away from what was said recently, so a
// quiet floor does not cycle the same few thoughts. Memory is per pool (keyed by
// the array itself), so pools must be module constants: a pool built fresh on
// every call has no history and falls back to a plain seeded pick.
const recentByPool = new WeakMap<readonly unknown[], unknown[]>();

/** An entry picked within the last half-a-pool's picks is skipped while any
 *  fresher entry exists; `seed` chooses among what is left. */
export function pickFresh<T>(pool: readonly T[], seed: number): T {
  if (pool.length <= 1) return pool[0];
  const recent = (recentByPool.get(pool) ?? []) as T[];
  const fresh = pool.filter((entry) => !recent.includes(entry));
  const choices = fresh.length ? fresh : pool;
  const chosen = choices[((Math.floor(seed) % choices.length) + choices.length) % choices.length];
  const memory = Math.floor(pool.length / 2);
  recentByPool.set(pool, [...recent.filter((entry) => entry !== chosen), chosen].slice(-memory));
  return chosen;
}

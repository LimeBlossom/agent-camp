/** Capabilities a card's work needs (The human, 2026-11-21: the work sets an agent's workspace,
 *  not a per-agent flag). Any of an agent's cards that is not done grants its needs. */
export const CARD_NEEDS = ['unity', 'network'] as const;
export type CardNeed = typeof CARD_NEEDS[number];

export function isCardNeed(v: unknown): v is CardNeed {
  return typeof v === 'string' && (CARD_NEEDS as readonly string[]).includes(v);
}

export function isCardNeeds(v: unknown): v is CardNeed[] {
  return Array.isArray(v) && v.every(isCardNeed);
}

export interface CardNeedsOf {
  needs: CardNeed[];
  /** Card ids granting each capability. */
  cards: Record<CardNeed, string[]>;
}

export function cardNeedsOf(tasks: readonly unknown[], agentId: string): CardNeedsOf {
  const cards = Object.fromEntries(CARD_NEEDS.map((n) => [n, [] as string[]])) as Record<CardNeed, string[]>;
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const c = t as { id?: unknown; assignee?: unknown; status?: unknown; needs?: unknown };
    if (c.assignee !== agentId || c.status === 'done' || !Array.isArray(c.needs)) continue;
    for (const n of c.needs) if (isCardNeed(n) && !cards[n].includes(String(c.id))) cards[n].push(String(c.id));
  }
  return { needs: CARD_NEEDS.filter((n) => cards[n].length > 0), cards };
}

/** Cards completed after repeated human send-backs whose difficulty is still below hard. */
export function completedCardsForDifficultyReview<T extends { id: string; status?: string; difficulty?: string; sendBacks?: number }>(cards: readonly T[]): T[] {
  return cards.filter((card) => card.status === 'done' && (card.sendBacks ?? 0) >= 2 && card.difficulty !== 'hard');
}

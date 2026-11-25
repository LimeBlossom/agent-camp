import { expiredReservations, reservationKey, describeReservation, type Reservation } from '../shared/reservations';

/** One notice per reservation once it passes `until`. The keys it has announced live in
 *  `load`/`save`, so a restart does not announce them again. A reservation dropped from
 *  the config before it ends is never announced. */
export class ReservationExpiryNotices {
  constructor(
    private readonly enabled: () => boolean,
    private readonly show: (title: string, body: string) => void,
    private readonly load: () => string[],
    private readonly save: (keys: string[]) => void
  ) {}

  check(reservations: readonly Reservation[], nowMs: number = Date.now()): void {
    const seen = new Set(this.load());
    const fresh = expiredReservations(reservations, nowMs).filter((r) => !seen.has(reservationKey(r)));
    if (!fresh.length) return;
    fresh.forEach((r) => seen.add(reservationKey(r)));
    this.save([...seen]);
    if (!this.enabled()) return;
    for (const r of fresh) this.show('Engine reservation ended', `${describeReservation(r)} has ended. ${r.provider} is open to all work again.`);
  }
}

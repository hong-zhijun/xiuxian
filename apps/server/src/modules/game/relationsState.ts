/** Shared cultivation gain and co-deployed bond modifiers. */
export function cultivationWithMentor(value: number, bonusBp = 0): number {
  return Math.floor(value * (10_000 + Math.max(0, bonusBp)) / 10_000);
}
export function bondBonusFor(
  disciple: { bond_partner_id?: string | null; bond_power_bp?: number },
  partyIds: readonly string[],
): number {
  return disciple.bond_partner_id && partyIds.includes(disciple.bond_partner_id) ? Math.max(0, disciple.bond_power_bp ?? 0) : 0;
}

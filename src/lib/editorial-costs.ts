/** Remaining allowance includes provider headroom and the final render. */
export function editorialRecoveryAllowanceCents(visualEstimateCents: number) {
  return Math.ceil(visualEstimateCents * 1.5) + 50;
}

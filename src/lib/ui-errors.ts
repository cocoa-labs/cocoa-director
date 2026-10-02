export function clearResolvedBackgroundError(
  currentError: string | null,
  resolvedBackgroundError: string | null,
) {
  if (!resolvedBackgroundError) return currentError;
  return currentError === resolvedBackgroundError ? null : currentError;
}

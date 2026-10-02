/** Repeat the existing editorial score with equal-power crossfades, then fade the ending. */
export function editorialScoreFilters(inputLabel: string, sourceSeconds: number, targetSeconds: number) {
  if (!Number.isFinite(sourceSeconds) || sourceSeconds <= 0) throw new Error("Editorial score duration is unavailable.");
  const crossfade = Math.min(2, sourceSeconds / 4);
  const copies = Math.max(1, Math.ceil((targetSeconds - crossfade) / (sourceSeconds - crossfade)));
  const filters = [`${inputLabel}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${sourceSeconds},asetpts=PTS-STARTPTS[score-source]`];
  if (copies > 1) {
    filters.push(`[score-source]asplit=${copies}${Array.from({ length: copies }, (_, i) => `[score-copy-${i}]`).join("")}`);
    for (let i = 1; i < copies; i++) filters.push(`[${i === 1 ? "score-copy-0" : `score-join-${i - 1}`}][score-copy-${i}]acrossfade=d=${crossfade}:c1=qsin:c2=qsin[score-join-${i}]`);
  }
  filters.push(`[${copies === 1 ? "score-source" : `score-join-${copies - 1}`}]apad,atrim=0:${targetSeconds},afade=t=out:st=${Math.max(0, targetSeconds - 3)}:d=3,volume=0.16[music]`);
  return filters;
}

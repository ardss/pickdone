/**
 * Shared sort-score core (P3-7, dw wave): single source for nextSort — previously the CLI kept a
 * verbatim copy (nextSortCli) of the renderer's utils/core.js nextSort. Both ends compute the same
 * ±512 step / 1024 baseline convention; pure function, no dependencies.
 *
 * Sort score (fround precision aligned with project baseline).
 *  custom mode displays by taskSort descending: addToTop = above the max; appending to the bottom must go below the min (minS-512).
 */
export function nextSort (addToTop, minS, maxS) {
  let s
  if (!minS && !maxS) s = 1024 // first element of the list, arbitrary baseline
  else if (addToTop) s = maxS + 512
  else s = minS - 512
  return Math.fround(s)
}

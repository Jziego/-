/** Soft cap on assets per store — bounds render complexity and write-rate-limit
 *  exposure (each upload = 3 writes against the 20/min write bucket). */
export const MAX_ASSETS_PER_STORE = 12;

/**
 * Decide how many of `fileCount` new uploads fit under the per-store cap given
 * the current library size. Pure so the cap logic is unit-testable without
 * rendering the dashboard.
 */
export function clampUploadBatch(
  currentCount: number,
  fileCount: number,
  max: number = MAX_ASSETS_PER_STORE
): { accepted: number; rejected: number } {
  const accepted = Math.max(0, Math.min(fileCount, max - currentCount));
  return { accepted, rejected: fileCount - accepted };
}

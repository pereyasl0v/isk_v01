// Presentation-only helpers. Retry timing comes from the backend so a page
// reload still displays the correct countdown for the running server job.
export function ozonRetryRemainingSeconds(retryAt, now = Date.now()) {
  if (!retryAt || typeof retryAt !== 'string') return 0;
  const target = Date.parse(retryAt);
  return Number.isFinite(target) ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
}

export function formatOzonRetryDuration(value) {
  const seconds = Math.max(0, Math.ceil(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  const leftover = seconds % 60;
  return minutes ? `${minutes} мин ${leftover} сек` : `${leftover} сек`;
}

export function isOzonRetryWaiting(job) {
  return Boolean(job?.running && job?.kind === 'digitization' && job?.retry_at);
}

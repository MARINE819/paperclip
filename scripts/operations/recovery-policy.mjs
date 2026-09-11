// Pure policy: no process, filesystem, or database side effects.
export function recoveryAction({ ready, runtimeAlive, portOpen, attempts, now, nextAttemptAt }) {
  if (ready) return 'healthy';
  if (runtimeAlive || portOpen) return 'manual-attention';
  if (attempts >= 3) return 'exhausted';
  if (now < nextAttemptAt) return 'cooldown';
  return 'start';
}

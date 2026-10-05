// Pure policy: no process, filesystem, or database side effects.
//
// apiReady/dbReady are independent health dimensions (the app server and the
// embedded Postgres cluster are separate processes and can fail independently).
// appPortOpen/dbPortOpen are likewise probed per-port so a live database no
// longer masks a dead app server: previously a single combined `portOpen`
// (either port) forced every app-only outage into 'manual-attention' because
// Postgres staying up looked identical to "something might already be
// starting on 3100". Only the app port's own occupancy is a duplicate-process
// signal for the app; the DB port's occupancy is not evidence either way
// about the app.
export function recoveryAction({
  apiReady,
  dbReady,
  runtimeAlive,
  appPortOpen,
  dbPortOpen,
  attempts,
  now,
  nextAttemptAt,
}) {
  if (apiReady && dbReady) return 'healthy';
  // A tracked runtime PID still alive, or something already bound to the app
  // port, means a start here could race a process this supervisor does not
  // own (or double-spawn its own). Unrelated to whether the DB happens to be
  // reachable right now.
  if (runtimeAlive || appPortOpen) return 'manual-attention';
  void dbPortOpen; // observability only; dbReady's own SELECT 1 is authoritative.
  if (attempts >= 3) return 'exhausted';
  if (now < nextAttemptAt) return 'cooldown';
  return 'start';
}

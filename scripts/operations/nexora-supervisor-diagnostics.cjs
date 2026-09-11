// Records otherwise invisible supervisor exits; never records environment or arguments.
const fs = require('node:fs');
const path = require('node:path');
const dir = 'C:\\Users\\Nexora\\.paperclip\\instances\\default\\logs';
function record(event, detail = {}) {
  try {
    fs.appendFileSync(path.join(dir, 'supervisor-diagnostics.jsonl'), JSON.stringify({
      at: new Date().toISOString(), event, pid: process.pid, parentPid: process.ppid, ...detail,
    }) + '\n');
  } catch { /* Diagnostic failure must not take down the supervisor. */ }
}
record('process_loaded');
process.on('uncaughtExceptionMonitor', (error, origin) => record('uncaught_exception', {
  origin, name: error.name, code: error.code,
}));
process.on('warning', (warning) => record('warning', { name: warning.name, code: warning.code }));
process.on('exit', (code) => record('process_exit', { code }));

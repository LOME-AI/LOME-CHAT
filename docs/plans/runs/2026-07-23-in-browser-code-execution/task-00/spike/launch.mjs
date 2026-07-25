// Launches both spike origins in one long-lived process so a background task
// keeps them alive. sandbox=:8191, app=:8190 (distinct ports = cross-origin).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const run = (dir, port, origin) =>
  spawn('node', [join(here, 'serve.mjs'), join(here, dir), String(port), origin ?? ''], {
    stdio: 'inherit',
  });
run('sandbox', 8191);
run('app', 8190, 'http://127.0.0.1:8191');
console.log('spike origins up: app :8190, sandbox :8191');
setInterval(() => {}, 1 << 30);

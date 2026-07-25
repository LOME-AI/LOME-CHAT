import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxConfigScript } from './config.js';
import { createRequestListener, resolveDevPort } from './dev-server.js';

// `pnpm dev` bootstrap for the sandbox origin. Env (HB_SANDBOX_PORT, ESM_CDN_URL)
// is loaded into the environment by scripts/with-env.ts before `turbo dev` fans
// out, and inherited here. All testable logic lives in dev-server.ts / config.ts;
// this file only wires them to a listening socket.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = resolveDevPort(process.env);
const listener = createRequestListener({
  publicDir: path.join(packageRoot, 'public'),
  configScript: buildSandboxConfigScript(process.env),
});

createServer(listener).listen(port, () => {
  console.log(`sandbox origin serving on http://localhost:${String(port)}`);
});

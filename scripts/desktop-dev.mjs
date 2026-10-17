// Run the desktop app in development: Vite dev server + Electron pointing at it.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ server: { port: 5174, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[opencad] dev server ${url}`);

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, OPENCAD_DEV_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

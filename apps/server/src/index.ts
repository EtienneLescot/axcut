import fs from 'node:fs';
import net from 'node:net';

import { createServer } from './app.js';
import { runtimeRoot, serverRuntimePath } from './lib/paths.js';

const preferredPort = Number.parseInt(process.env.AXCUT_SERVER_PORT ?? '4010', 10);
const host = process.env.AXCUT_SERVER_HOST ?? '127.0.0.1';

async function isPortAvailable(port: number, hostName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, hostName);
  });
}

async function resolveServerPort(startPort: number, hostName: string): Promise<number> {
  for (let candidate = startPort; candidate < startPort + 20; candidate += 1) {
    if (await isPortAvailable(candidate, hostName)) {
      return candidate;
    }
  }

  throw new Error(`No free Axcut server port found between ${startPort} and ${startPort + 19}.`);
}

const server = await createServer();
const port = await resolveServerPort(preferredPort, host);
await server.listen({ port, host });
fs.mkdirSync(runtimeRoot, { recursive: true });
fs.writeFileSync(serverRuntimePath, `${JSON.stringify({ host, port, url: `http://${host}:${port}` }, null, 2)}\n`, 'utf-8');
if (port !== preferredPort) {
  server.log.warn(`Preferred Axcut port ${preferredPort} was busy, using ${port} instead.`);
}
server.log.info(`Axcut server listening on http://${host}:${port}`);

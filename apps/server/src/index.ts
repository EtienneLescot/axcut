import { createServer } from './app.js';

const port = Number.parseInt(process.env.AXCUT_SERVER_PORT ?? '4010', 10);
const host = process.env.AXCUT_SERVER_HOST ?? '127.0.0.1';

const server = await createServer();
await server.listen({ port, host });
server.log.info(`Axcut server listening on http://${host}:${port}`);

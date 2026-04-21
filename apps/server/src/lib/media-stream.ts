import fs from 'node:fs';
import path from 'node:path';

import type { FastifyReply, FastifyRequest } from 'fastify';

const mimeByExtension = new Map<string, string>([
  ['.mp4', 'video/mp4'],
  ['.json', 'application/json'],
  ['.axcut', 'text/plain; charset=utf-8'],
]);

export async function streamFile(request: FastifyRequest, reply: FastifyReply, filePath: string): Promise<void> {
  const stats = await fs.promises.stat(filePath);
  const range = request.headers.range;
  const contentType = mimeByExtension.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';

  if (!range) {
    reply.header('Content-Type', contentType);
    reply.header('Content-Length', String(stats.size));
    reply.send(fs.createReadStream(filePath));
    return;
  }

  const [startPart, endPart] = range.replace(/bytes=/, '').split('-');
  const start = Number.parseInt(startPart, 10);
  const end = endPart ? Number.parseInt(endPart, 10) : stats.size - 1;
  const safeStart = Number.isFinite(start) ? start : 0;
  const safeEnd = Number.isFinite(end) ? Math.min(end, stats.size - 1) : stats.size - 1;

  reply.code(206);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType);
  reply.header('Content-Length', String(safeEnd - safeStart + 1));
  reply.header('Content-Range', `bytes ${safeStart}-${safeEnd}/${stats.size}`);
  reply.send(fs.createReadStream(filePath, { start: safeStart, end: safeEnd }));
}

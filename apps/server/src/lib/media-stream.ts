import fs from 'node:fs';
import path from 'node:path';
import type { ReadStream } from 'node:fs';

import type { FastifyReply, FastifyRequest } from 'fastify';

const mimeByExtension = new Map<string, string>([
  ['.mp4', 'video/mp4'],
  ['.json', 'application/json'],
  ['.axcut', 'text/plain; charset=utf-8'],
]);

export async function streamFile(request: FastifyRequest, reply: FastifyReply, filePath: string): Promise<ReadStream | void> {
  const stats = await fs.promises.stat(filePath);
  const range = request.headers.range;
  const contentType = mimeByExtension.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';

  if (!range) {
    reply.header('Content-Type', contentType);
    reply.header('Content-Length', String(stats.size));
    return fs.createReadStream(filePath);
  }

  const parsedRange = parseByteRange(range, stats.size);
  if (!parsedRange) {
    reply.code(416);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Range', `bytes */${stats.size}`);
    reply.send();
    return;
  }

  const { start: safeStart, end: safeEnd } = parsedRange;

  reply.code(206);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType);
  reply.header('Content-Length', String(safeEnd - safeStart + 1));
  reply.header('Content-Range', `bytes ${safeStart}-${safeEnd}/${stats.size}`);
  return fs.createReadStream(filePath, { start: safeStart, end: safeEnd });
}

function parseByteRange(range: string, size: number): { start: number; end: number } | null {
  if (size <= 0) {
    return null;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }

  const [, startPart, endPart] = match;
  if (!startPart && !endPart) {
    return null;
  }

  if (!startPart) {
    const suffixLength = Number.parseInt(endPart, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number.parseInt(startPart, 10);
  const end = endPart ? Number.parseInt(endPart, 10) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

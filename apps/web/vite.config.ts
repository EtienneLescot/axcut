import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');
const serverRuntimePath = path.join(repoRoot, '.axcut-data', 'runtime', 'server.json');
const defaultServerUrl = 'http://127.0.0.1:4010';

function resolveBackendTarget(): string {
  try {
    const runtime = JSON.parse(fs.readFileSync(serverRuntimePath, 'utf-8')) as { url?: string };
    if (runtime.url) {
      return runtime.url;
    }
  } catch {
    // Fall back to the default development port until the server publishes its runtime file.
  }
  return defaultServerUrl;
}

const apiProxy: ProxyOptions = {
  target: defaultServerUrl,
  changeOrigin: true,
  router: () => resolveBackendTarget(),
} as ProxyOptions;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiProxy,
    },
  },
});

import fs from 'node:fs';
import process from 'node:process';

const repoRoot = fs.realpathSync(new URL('..', import.meta.url));
const currentPid = process.pid;

const devProcessPatterns = [
  /(?:^|\s)concurrently(?:\s|$)/,
  /npm\s+run\s+dev(?::server|:web)?/,
  /tsx\s+watch\s+src\/index\.ts/,
  /vite(?:\.js)?(?:\s|$)/,
];

function readProcessInfo(pid) {
  try {
    const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    return { cwd, cmdline };
  } catch {
    return undefined;
  }
}

function isAxcutDevProcess(pid, info) {
  if (pid === currentPid || !info.cmdline) {
    return false;
  }
  if (info.cwd !== repoRoot && !info.cwd.startsWith(`${repoRoot}/`)) {
    return false;
  }
  return devProcessPatterns.some((pattern) => pattern.test(info.cmdline));
}

const targets = fs.readdirSync('/proc')
  .filter((entry) => /^\d+$/.test(entry))
  .map((entry) => Number.parseInt(entry, 10))
  .map((pid) => ({ pid, info: readProcessInfo(pid) }))
  .filter((entry) => entry.info && isAxcutDevProcess(entry.pid, entry.info));

for (const { pid, info } of targets) {
  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`Stopped ${pid}: ${info.cmdline}\n`);
  } catch (error) {
    process.stderr.write(`Could not stop ${pid}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

if (targets.length === 0) {
  process.stdout.write('No Axcut dev processes found.\n');
}

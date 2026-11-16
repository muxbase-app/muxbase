import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Owned-check process did not reach its expected state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isRunning(pid: number): boolean {
  try {
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('owned Team checks after a parent crash', () => {
  it('drains a TERM-resistant descendant when the launching process is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'muxbase-check-crash-'));
    roots.push(root);
    const marker = join(root, 'descendant.pid');
    const launcher = join(root, 'launcher.mjs');
    const entry = resolve('src/main/services/team/teamCheckOwner.mjs');
    writeFileSync(launcher, `
      import { fork } from 'node:child_process';
      const owner = fork(${JSON.stringify(entry)}, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      owner.send({ command: "sh -c 'trap \\"\\" TERM; exec sleep 30' >/dev/null 2>&1 & echo $! > descendant.pid; wait", cwd: ${JSON.stringify(root)}, timeoutMs: 20000 });
    `);
    const parent = fork(launcher, [], { stdio: 'ignore' });
    const exited = once(parent, 'exit');
    let descendant: number | undefined;
    try {
      await waitFor(() => existsSync(marker));
      descendant = Number(readFileSync(marker, 'utf8').trim());
      expect(descendant).toBeGreaterThan(0);
      expect(isRunning(descendant)).toBe(true);

      parent.kill('SIGKILL');
      await exited;

      await waitFor(() => !isRunning(descendant!));
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      if (descendant && isRunning(descendant)) process.kill(descendant, 'SIGKILL');
    }
  }, 15_000);
});

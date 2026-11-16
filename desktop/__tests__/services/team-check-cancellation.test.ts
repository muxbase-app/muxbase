import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runTeamCheck } from '../../src/main/services/team/teamChecks.js';

vi.mock('../../src/main/services/git/gitDiff.js', () => ({ gitOrThrow: vi.fn() }));

function isProcessRunning(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

describe('team check cancellation', () => {
  it('fails an already cancelled command without executing it', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runTeamCheck(process.cwd(), 'printf should-not-run', controller.signal);
    expect(result).toMatchObject({ passed: false });
    expect(result.output).toMatch(/cancel/i);
    expect(result.output).not.toContain('should-not-run');
  });

  it('drains an owned process group when cancelled', async () => {
    const controller = new AbortController();
    const running = runTeamCheck(process.cwd(), 'sleep 30 & wait', controller.signal);
    setTimeout(() => controller.abort(), 30);
    expect(await running).toMatchObject({ output: expect.stringMatching(/cancel/i), passed: false });
  }, 15_000);

  it('bounds output without losing an ordinary successful result', async () => {
    const result = await runTeamCheck(process.cwd(), 'printf successful');
    expect(result).toEqual({ output: 'successful', passed: true });
  }, 15_000);

  it('retains exactly the bounded tail of a large successful check output', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(7000) + 'done')"`;
    const result = await runTeamCheck(process.cwd(), command);
    expect(result.passed).toBe(true);
    expect(result.output).toHaveLength(6000);
    expect(result.output.endsWith('done')).toBe(true);
  }, 15_000);

  it('surfaces an unavailable working directory as a failed check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'muxbase-check-missing-'));
    try {
      const result = await runTeamCheck(join(root, 'missing'), 'printf must-not-run');
      expect(result.passed).toBe(false);
      expect(result.output).toMatch(/ENOENT/);
      expect(result.output).not.toContain('must-not-run');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);

  it('drains background descendants even when they retain the shell output pipes', async () => {
    const controller = new AbortController();
    const running = runTeamCheck(process.cwd(), 'sleep 30 & printf successful', controller.signal);
    try {
      await expect(Promise.race([
        running,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Background descendant retained the check output pipes')), 5000).unref();
        }),
      ])).resolves.toEqual({ output: 'successful', passed: true });
    } finally {
      controller.abort();
      await running;
    }
  }, 15_000);

  it('kills owned descendants that ignore TERM and close their output streams', async () => {
    const controller = new AbortController();
    const root = mkdtempSync(join(tmpdir(), 'muxbase-check-cancel-'));
    const marker = join(root, 'descendant.pid');
    const running = runTeamCheck(root, `sh -c 'trap "" TERM; exec sleep 30' >/dev/null 2>&1 & echo $! > descendant.pid; wait`, controller.signal);
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error('Owned check did not start its descendant');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      pid = Number(readFileSync(marker, 'utf8').trim());
      expect(pid).toBeGreaterThan(0);
      controller.abort();
      expect(await running).toMatchObject({ passed: false, output: expect.stringMatching(/cancel/i) });
      expect(isProcessRunning(pid)).toBe(false);
    } finally {
      controller.abort();
      await running;
      if (pid && isProcessRunning(pid)) process.kill(pid, 'SIGKILL');
      rmSync(root, { force: true, recursive: true });
    }
  }, 20_000);
});

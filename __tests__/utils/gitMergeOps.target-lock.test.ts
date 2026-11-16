import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeWorktreeIntoMain } from '../../src/utils/gitMergeOps.js';

const git = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('../../src/utils/execAsync.js', () => ({ execFileAsync: git.exec }));
vi.mock('../../src/utils/conflictMergeTransaction.js', () => ({
  findConflictMergeTransactionForMerge: () => undefined,
  inspectConflictMergeState: () => ({ status: 'clean' }),
}));
const roots: string[] = [];
beforeEach(() => { git.exec.mockReset(); git.exec.mockResolvedValue(''); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

function target(): string {
  const root = mkdtempSync(join(tmpdir(), 'muxbase-target-merge-test-'));
  roots.push(root);
  return root;
}

describe('Final target merge boundary', () => {
  it('serializes validation and rejects the second certificate when another merge moves the target', async () => {
    const root = target();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let head = 'approved-target';
    const calls: string[] = [];
    git.exec.mockImplementation(async () => { head = 'merged-a'; return ''; });
    const first = mergeWorktreeIntoMain(root, 'source-a', async () => {
      calls.push('a');
      await gate;
      return null;
    });
    const second = mergeWorktreeIntoMain(root, 'source-b', async () => {
      calls.push('b');
      return head === 'approved-target' ? null : 'Approval target changed';
    });
    await Promise.resolve();
    expect(calls).toEqual(['a']);
    release();

    expect(await first).toEqual({ success: true });
    expect(await second).toMatchObject({ error: 'Approval target changed', success: false });
    expect(calls).toEqual(['a', 'b']);
    expect(git.exec).toHaveBeenCalledTimes(1);
    expect(git.exec).toHaveBeenCalledWith('git', ['merge', 'source-a', '--no-edit'], expect.objectContaining({ cwd: root }));
  });

  it('releases the target after a validation exception without hiding the error', async () => {
    const root = target();
    await expect(mergeWorktreeIntoMain(root, 'source-a', async () => {
      throw new Error('Snapshot failure');
    })).rejects.toThrow('Snapshot failure');

    expect(await mergeWorktreeIntoMain(root, 'source-b')).toEqual({ success: true });
    expect(git.exec).toHaveBeenCalledTimes(1);
  });
});

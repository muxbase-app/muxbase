import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverCertifiedPublication } from '../../src/utils/certifiedPublication.js';
import { mergeWorktreeIntoMain } from '../../src/utils/gitMergeOps.js';
import { prepareHeadUpdate } from '../../src/utils/gitRefTransaction.js';
import { TeamPublicationJournal } from '../../src/utils/teamPublicationJournal.js';

const roots: string[] = [];
const boundary = vi.hoisted(() => ({ interrupt: undefined as (() => void) | undefined }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: new Proxy(actual.execFile, {
      apply(target, receiver, args) {
        const command = args[1];
        if (Array.isArray(command) && ((command.includes('merge') && command.includes('--ff-only'))
          || (command.includes('read-tree') && !command.includes('--dry-run')))) {
          const interrupt = boundary.interrupt;
          boundary.interrupt = undefined;
          interrupt?.();
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  };
});
function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'muxbase-certified-target-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['config', 'user.name', 'Merge test']);
  git(root, ['config', 'user.email', 'merge@example.test']);
  writeFileSync(join(root, 'code.txt'), 'base\n');
  writeFileSync(join(root, 'notes.txt'), 'notes\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const targetSha = git(root, ['rev-parse', 'HEAD']);
  const source = join(root, 'writer');
  git(root, ['worktree', 'add', '-qb', 'writer', source]);
  writeFileSync(join(source, 'code.txt'), 'reviewed\n');
  git(source, ['commit', '-qam', 'reviewed change']);
  const sourceSha = git(source, ['rev-parse', 'HEAD']);
  return { root, sourceSha, publication: { operationId: 'test-operation', targetRef: 'refs/heads/main', targetSha } };
}
afterEach(() => {
  boundary.interrupt = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Certified target publication with native Git', () => {
  it.each([
    ['checkout', ['checkout', 'other']],
    ['symbolic HEAD change', ['symbolic-ref', 'HEAD', 'refs/heads/other']],
    ['target ref write', ['update-ref', 'refs/heads/main', 'refs/heads/other']],
    ['index write', ['add', 'notes.txt']],
  ])('owns the checkout, HEAD, target and index against a late external %s', async (_label, command) => {
    const { root, sourceSha, publication } = repository();
    git(root, ['branch', 'other']);
    let externalStatus: number | null | undefined;
    boundary.interrupt = () => {
      externalStatus = spawnSync('git', command, { cwd: root, encoding: 'utf8' }).status;
    };

    const result = await mergeWorktreeIntoMain(root, sourceSha, async () => null, publication);

    expect(externalStatus).not.toBeUndefined();
    expect(externalStatus).not.toBe(0);
    expect(result.success, result.error).toBe(true);
    expect(git(root, ['symbolic-ref', 'HEAD'])).toBe(publication.targetRef);
    expect(git(root, ['rev-parse', 'main'])).toBe(sourceSha);
    expect(git(root, ['rev-parse', 'other'])).toBe(publication.targetSha);
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('reviewed\n');
    expect(git(root, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('rejects an external target commit inserted after final validation instead of combining unchecked trees', async () => {
    const { root, sourceSha, publication } = repository();
    let external = '';

    const result = await mergeWorktreeIntoMain(root, sourceSha, async () => {
      writeFileSync(join(root, 'external.txt'), 'external change\n');
      git(root, ['add', 'external.txt']);
      git(root, ['commit', '-qm', 'external writer']);
      external = git(root, ['rev-parse', 'HEAD']);
      return null;
    }, publication);

    expect(result.success).toBe(false);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(external);
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('base\n');
  });

  it('rejects a different checked-out target branch even when it has the same starting commit', async () => {
    const { root, sourceSha, publication } = repository();

    const result = await mergeWorktreeIntoMain(root, sourceSha, async () => {
      git(root, ['checkout', '-qb', 'other']);
      return null;
    }, publication);

    expect(result.success).toBe(false);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(publication.targetSha);
  });

  it('publishes exactly the reviewed commit and preserves unrelated local work despite merge.ff=false', async () => {
    const { root, sourceSha, publication } = repository();
    git(root, ['config', 'merge.ff', 'false']);
    writeFileSync(join(root, 'notes.txt'), 'uncommitted user notes\n');
    writeFileSync(join(root, 'untracked.txt'), 'untracked user work\n');

    const result = await mergeWorktreeIntoMain(root, sourceSha, async () => null, publication);

    expect(result.success).toBe(true);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(sourceSha);
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('uncommitted user notes\n');
    expect(readFileSync(join(root, 'untracked.txt'), 'utf8')).toBe('untracked user work\n');
    expect(git(root, ['reflog', '-1', '--format=%gs', publication.targetRef])).toContain('muxbase-team-merge:test-operation');
  });

  it('refuses an overlapping local edit before checkout without leaving an owned lock or journal', async () => {
    const { root, sourceSha, publication } = repository();
    writeFileSync(join(root, 'code.txt'), 'uncommitted user changes\n');

    const result = await mergeWorktreeIntoMain(root, sourceSha, undefined, publication);

    expect(result.success).toBe(false);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(publication.targetSha);
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('uncommitted user changes\n');
    expect(existsSync(join(root, '.git', 'index.lock'))).toBe(false);
    expect(existsSync(join(root, '.git', 'muxbase-team-publication.json'))).toBe(false);
  });

  it('publishes safely into a linked target worktree with its own HEAD and index', async () => {
    const { root, sourceSha, publication } = repository();
    const target = join(root, 'target');
    git(root, ['checkout', '--detach', publication.targetSha]);
    git(root, ['worktree', 'add', target, 'main']);

    const result = await mergeWorktreeIntoMain(target, sourceSha, undefined, publication);

    expect(result.success, result.error).toBe(true);
    expect(git(target, ['rev-parse', 'HEAD'])).toBe(sourceSha);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(publication.targetSha);
    expect(readFileSync(join(target, 'code.txt'), 'utf8')).toBe('reviewed\n');
    expect(git(target, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('preserves the existing Git index access mode even under a restrictive umask', async () => {
    const { root, sourceSha, publication } = repository();
    chmodSync(join(root, '.git', 'index'), 0o660);
    const previousMask = process.umask(0o077);

    try {
      const result = await mergeWorktreeIntoMain(root, sourceSha, undefined, publication);

      expect(result.success, result.error).toBe(true);
      expect(statSync(join(root, '.git', 'index')).mode & 0o777).toBe(0o660);
    } finally { process.umask(previousMask); }
  });

  it('releases its interrupted pre-checkout ownership without guessing publication', async () => {
    const { root, sourceSha, publication } = repository();
    const journal = await TeamPublicationJournal.at(root, publication.operationId);
    journal.acquire(publication, sourceSha);

    expect(await recoverCertifiedPublication(root, publication, sourceSha)).toBe(false);

    expect(git(root, ['rev-parse', 'HEAD'])).toBe(publication.targetSha);
    expect(existsSync(journal.lockPath)).toBe(false);
    expect(existsSync(journal.path)).toBe(false);
  });

  it.each(['checkout', 'index', 'publication'] as const)('recovers a sealed %s boundary without duplicate publication or lost user edits', async (phase) => {
    const { root, sourceSha, publication } = repository();
    const journal = await TeamPublicationJournal.at(root, publication.operationId);
    let record = { ...journal.acquire(publication, sourceSha), checkoutStarted: true };
    journal.write(record);
    const transaction = await prepareHeadUpdate(root, sourceSha, publication.targetSha, `muxbase-team-merge:${publication.operationId}: publish`);
    try {
      execFileSync('git', ['read-tree', '-m', '-u', publication.targetSha, sourceSha], {
        cwd: root, env: { ...process.env, GIT_INDEX_FILE: journal.stagePath },
      });
      record = journal.seal(record);
      if (phase !== 'checkout') record = journal.install(record);
      if (phase === 'publication') await transaction.commit();
    } finally { await transaction.abort(); }
    writeFileSync(join(root, 'code.txt'), 'user edit after interruption\n');
    writeFileSync(join(root, 'untracked.txt'), 'user work\n');

    expect(await recoverCertifiedPublication(root, publication, sourceSha)).toBe(true);

    expect(git(root, ['rev-parse', 'HEAD'])).toBe(sourceSha);
    expect(git(root, ['diff', '--cached', '--name-only'])).toBe('');
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('user edit after interruption\n');
    expect(readFileSync(join(root, 'untracked.txt'), 'utf8')).toBe('user work\n');
    expect(git(root, ['reflog', '--format=%gs', publication.targetRef]).split('\n')
      .filter((entry) => entry.includes(`muxbase-team-merge:${publication.operationId}:`))).toHaveLength(1);
    expect(existsSync(journal.lockPath)).toBe(false);
    expect(existsSync(journal.path)).toBe(false);
    expect(await recoverCertifiedPublication(root, publication, sourceSha)).toBe(false);
  });

  it('preserves ownership when checkout completion is unknown rather than overwriting work during recovery', async () => {
    const { root, sourceSha, publication } = repository();
    const journal = await TeamPublicationJournal.at(root, publication.operationId);
    journal.write({ ...journal.acquire(publication, sourceSha), checkoutStarted: true });

    await expect(recoverCertifiedPublication(root, publication, sourceSha)).rejects.toThrow(/interrupted during checkout/);

    expect(git(root, ['rev-parse', 'HEAD'])).toBe(publication.targetSha);
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(journal.lockPath)).toBe(true);
    expect(existsSync(journal.path)).toBe(true);
  });

  it('does not replace another index owner during interrupted publication recovery', async () => {
    const { root, sourceSha, publication } = repository();
    const journal = await TeamPublicationJournal.at(root, publication.operationId);
    const record = journal.acquire(publication, sourceSha);
    journal.write({ ...record, checkoutCompleted: true, checkoutStarted: true, stagedIndexHash: record.originalIndexHash });
    writeFileSync(journal.lockPath, 'another Git operation\n');

    await expect(recoverCertifiedPublication(root, publication, sourceSha)).rejects.toThrow(/no longer owned/);

    expect(readFileSync(journal.lockPath, 'utf8')).toBe('another Git operation\n');
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(publication.targetSha);
  });
});

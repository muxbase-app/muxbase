import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeWorktreeIntoMain } from '../../../src/utils/gitMergeOps.js';
import { prepareHeadUpdate } from '../../../src/utils/gitRefTransaction.js';
import { TeamPublicationJournal } from '../../../src/utils/teamPublicationJournal.js';
import { TeamWorkflow } from '../../src/main/services/bridge/TeamWorkflow.js';
import { cleanupTeamModeFixtures, fixture, git } from './team-mode-test-support.js';

async function approvedSource() {
  const f = await fixture();
  await f.step();
  await f.step();
  await f.step();
  await f.answer();
  await f.step();
  const pane = f.panes.get('developer');
  if (!pane?.worktreePath) throw new Error('Writer is missing');
  git(pane.worktreePath, ['add', 'code.txt']);
  git(pane.worktreePath, ['commit', '-qm', 'approved source']);
  return { ...f, pane, sourceSha: git(pane.worktreePath, ['rev-parse', 'HEAD']) };
}
afterEach(cleanupTeamModeFixtures);

describe('Durable Team merge receipts', () => {
  it('keeps confirmed Git success visible when an external ref move prevents interrupted index recovery', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    const journal = await TeamPublicationJournal.at(f.root, publication.operationId);
    let record = { ...journal.acquire(publication, f.sourceSha), checkoutStarted: true };
    journal.write(record);
    const transaction = await prepareHeadUpdate(f.root, f.sourceSha, publication.targetSha, `muxbase-team-merge:${publication.operationId}: publish`);
    try {
      execFileSync('git', ['read-tree', '-m', '-u', publication.targetSha, f.sourceSha], {
        cwd: f.root, env: { ...process.env, GIT_INDEX_FILE: journal.stagePath },
      });
      record = journal.install(journal.seal(record));
      await transaction.commit();
    } finally { await transaction.abort(); }
    const external = git(f.root, ['commit-tree', `${f.sourceSha}^{tree}`, '-p', f.sourceSha, '-m', 'external ref advancement']);
    git(f.root, ['update-ref', publication.targetRef, external, f.sourceSha]);
    const restarted = new TeamWorkflow(f.dependencies);

    await restarted.recoverPaneMerges();

    expect(restarted.list()[0]).toMatchObject({
      error: expect.stringContaining('moved externally'),
      mergeIntent: { state: 'published' },
      status: 'merged',
    });
    expect(existsSync(journal.lockPath)).toBe(true);
    expect(f.panes.has('developer')).toBe(true);
    expect(f.panes.has('tester')).toBe(true);
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(external);
  });

  it('preserves a failed hook outcome across restart without changing the successful Git publication', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    expect((await mergeWorktreeIntoMain(f.root, f.sourceSha, async () => null, publication)).success).toBe(true);
    expect(await f.workflow.completePaneMerge(f.pane)).toBeNull();
    f.workflow.beginMergeHook(f.pane);
    f.workflow.completeMergeHook(f.pane, 'Git merged, but the post-merge hook failed: exit 7');
    const restarted = new TeamWorkflow(f.dependencies);

    await restarted.recoverPaneMerges();

    expect(restarted.list()[0]).toMatchObject({
      error: expect.stringContaining('exit 7'),
      mergeIntent: { hook: { state: 'failed' }, sourceSha: f.sourceSha },
      status: 'merged',
    });
    expect(() => restarted.beginMergeHook(f.pane)).toThrow(/already|repeat/i);
  });

  it('records an interrupted hook attempt as unknown after restart and refuses automatic repetition', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    expect((await mergeWorktreeIntoMain(f.root, f.sourceSha, async () => null, publication)).success).toBe(true);
    expect(await f.workflow.completePaneMerge(f.pane)).toBeNull();
    expect(f.workflow.beginMergeHook(f.pane)).toBe(publication.operationId);
    const restarted = new TeamWorkflow(f.dependencies);

    await restarted.recoverPaneMerges();

    expect(restarted.list()[0].mergeIntent?.hook?.state).toBe('unknown');
    expect(restarted.list()[0].status).toBe('merged');
    expect(restarted.list()[0].error).toMatch(/hook.*unknown|unknown.*hook/i);
    expect(() => restarted.beginMergeHook(f.pane)).toThrow(/already|repeat|record/i);
  });

  it('persists a successful hook outcome and never reserves the same publication hook twice', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    expect((await mergeWorktreeIntoMain(f.root, f.sourceSha, async () => null, publication)).success).toBe(true);
    expect(await f.workflow.completePaneMerge(f.pane)).toBeNull();
    expect(f.workflow.beginMergeHook(f.pane)).toBe(publication.operationId);
    f.workflow.completeMergeHook(f.pane);
    const restarted = new TeamWorkflow(f.dependencies);

    await restarted.recoverPaneMerges();

    expect(restarted.list()[0].mergeIntent?.hook?.state).toBe('succeeded');
    expect(restarted.list()[0].error).toBeUndefined();
    expect(() => restarted.beginMergeHook(f.pane)).toThrow(/already|repeat|record/i);
  });

  it('rejects a missing target reflog before publication rather than merging without a recoverable receipt', async () => {
    const f = await approvedSource();
    git(f.root, ['reflog', 'expire', '--expire=all', '--all']);

    await expect(f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha)).rejects.toThrow(/reflog/i);

    expect(f.workflow.list()[0].mergeIntent).toBeUndefined();
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.ledger.get(f.runId).baseSha);
  });

  it('retries interrupted reviewer cleanup after publication without repeating Git or deleting the writer', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    expect((await mergeWorktreeIntoMain(f.root, f.sourceSha, async () => null, publication)).success).toBe(true);
    const close = f.dependencies.closePane;
    f.dependencies.closePane = async () => 'injected cleanup interruption';

    expect(await f.workflow.completePaneMerge(f.pane)).toMatch(/cleanup/i);
    expect(f.workflow.list()[0].status).toBe('merged');
    expect(f.workflow.list()[0].mergeIntent?.state).toBe('published');
    f.dependencies.closePane = close;
    const restarted = new TeamWorkflow(f.dependencies);
    await restarted.recoverPaneMerges();

    expect(restarted.list()[0].mergeIntent?.state).toBe('cleaned');
    expect(f.panes.has('developer')).toBe(true);
    expect(f.panes.has('tester')).toBe(false);
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.sourceSha);
  });

  it('preserves an unpublished intent and dirty target after a crash rather than guessing that Git never started', async () => {
    const f = await approvedSource();
    await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    writeFileSync(join(f.root, 'code.txt'), 'interrupted target checkout\n');
    const restarted = new TeamWorkflow(f.dependencies);

    await restarted.recoverPaneMerges();

    expect(restarted.list()[0].status).toBe('failed');
    expect(restarted.list()[0].mergeIntent?.state).toBe('prepared');
    expect(f.panes.has('developer')).toBe(true);
    expect(git(f.root, ['diff', '--', 'code.txt'])).toContain('interrupted target checkout');
    expect((await restarted.finish({ outcome: 'merged', runId: f.runId })).success).toBe(false);
  });

  it('does not reconcile a live local publication as an interrupted transaction', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);

    await f.workflow.recoverPaneMerges();

    expect(f.workflow.list()[0].status).toBe('ready');
    expect(f.workflow.list()[0].mergeIntent?.operationId).toBe(publication.operationId);
    expect((await f.workflow.finish({ outcome: 'merged', runId: f.runId })).success).toBe(false);
    expect((await f.workflow.finish({ outcome: 'stopped', runId: f.runId })).success).toBe(false);
    expect((await mergeWorktreeIntoMain(f.root, f.sourceSha, async () => null, publication)).success).toBe(true);
    expect(await f.workflow.completePaneMerge(f.pane)).toBeNull();
  });

  it('preserves a reviewer slot whose pane ownership changed before cleanup recovery', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    expect((await mergeWorktreeIntoMain(f.root, f.sourceSha, async () => null, publication)).success).toBe(true);
    const reviewer = f.panes.get('tester');
    if (!reviewer) throw new Error('Reviewer is missing');
    f.panes.set('tester', { ...reviewer, worktreePath: f.pane.worktreePath });

    expect(await f.workflow.completePaneMerge(f.pane)).toMatch(/ownership/i);
    expect(f.workflow.list()[0].status).toBe('merged');
    expect(f.workflow.list()[0].mergeIntent?.state).toBe('published');
    expect(f.panes.has('tester')).toBe(true);
    expect(f.panes.has('developer')).toBe(true);
  });

  it('reconciles Git publication after restart before Team acknowledgement without requiring the writer to remain unchanged', async () => {
    const f = await approvedSource();
    const publication = await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    expect((await mergeWorktreeIntoMain(f.root, f.sourceSha, async () => null, publication)).success).toBe(true);
    writeFileSync(join(f.pane.worktreePath!, 'code.txt'), 'later writer edits\n');
    const restarted = new TeamWorkflow(f.dependencies);
    restarted.list();

    await restarted.recoverPaneMerges();

    expect(restarted.list()[0].status).toBe('merged');
    expect(restarted.list()[0].mergeIntent?.state).toBe('cleaned');
    expect(f.panes.has('developer')).toBe(true);
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.sourceSha);
  });

  it('does not infer its own merge from an external publication of identical code', async () => {
    const f = await approvedSource();
    await f.workflow.beginPaneMerge(f.pane, f.root, f.sourceSha);
    git(f.root, ['merge', '--ff-only', f.sourceSha]);
    const restarted = new TeamWorkflow(f.dependencies);
    restarted.list();

    await restarted.recoverPaneMerges();

    expect(restarted.list()[0].status).not.toBe('merged');
    expect(restarted.list()[0].error).toMatch(/receipt|publication|ambiguous/i);
    expect(f.panes.has('developer')).toBe(true);
  });

  it('does not publish without a durable certified merge intent', async () => {
    const f = await approvedSource();

    expect(await f.workflow.completePaneMerge(f.pane)).toMatch(/intent|receipt/i);
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.ledger.get(f.runId).baseSha);
  });
});

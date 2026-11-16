import { hasCertifiedPublicationReceipt, type MuxBasePane, recoverCertifiedPublication } from 'muxbase/core';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { TeamMergeIntent, TeamRun } from '../../../shared/team-types.js';
import { formatError } from '../../utils/formatError.js';
import { gitOrThrow } from '../git/gitDiff.js';
import { log } from '../Logger.js';
import type { TeamApprovalWorkflow } from './TeamApprovalWorkflow.js';
import type { TeamExecution } from './TeamExecution.js';
import type { TeamLedger } from './TeamLedger.js';
import type { TeamMemberLifecycle } from './TeamMemberLifecycle.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export class TeamMergeWorkflow {
  private recovery?: Promise<void>;
  private readonly publishing = new Set<string>();
  private readonly hooking = new Set<string>();

  constructor(
    private readonly ledger: TeamLedger,
    private readonly dependencies: TeamWorkflowDependencies,
    private readonly execution: TeamExecution,
    private readonly approvals: TeamApprovalWorkflow,
    private readonly members: TeamMemberLifecycle,
  ) {}

  async begin(pane: MuxBasePane, targetPath: string, sourceSha: string): Promise<TeamMergeIntent> {
    await this.recovery;
    const run = this.execution.runs().find((candidate) => candidate.members.some((member) => member.paneId === pane.id));
    if (!run) throw new Error('The merged pane has no recoverable Team run');
    if (run.mergeIntent) {
      throw new Error('This Team merge already has a durable publication intent. Recover it before retrying.');
    }
    if (realpathSync(targetPath) !== realpathSync(run.projectRoot)) throw new Error('The Team merge target worktree changed.');
    const invalid = await this.approvals.validate(pane, pane.worktreePath, sourceSha);
    if (invalid) throw new Error(invalid);
    const current = this.ledger.get(run.id);
    if (!current.approval) throw new Error('The Team approval certificate is missing.');
    const targetRef = (await gitOrThrow(run.projectRoot, ['symbolic-ref', '-q', 'HEAD'])).trim();
    const targetSha = await this.head(run);
    if (targetSha !== current.approval.targetSha) throw new Error('The approved merge target changed.');
    const loggedTarget = (await gitOrThrow(run.projectRoot, ['reflog', 'show', '-1', '--format=%H', targetRef])).trim();
    if (loggedTarget !== targetSha) throw new Error('The target Git reflog does not record the expected commit. Restore its recording policy before publishing a Team merge.');
    await gitOrThrow(run.projectRoot, ['merge-base', '--is-ancestor', targetSha, sourceSha]);
    const intent: TeamMergeIntent = {
      approval: structuredClone(current.approval),
      operationId: randomUUID(),
      sourcePaneId: pane.id,
      sourceSha,
      state: 'prepared',
      targetRef,
      targetSha,
    };
    this.execution.assert(current);
    this.ledger.commit(run.id, { intent, type: 'merge-intent' });
    this.publishing.add(run.id);
    return intent;
  }

  async completePane(pane: MuxBasePane): Promise<string | null> {
    const run = this.ledger.list().find((candidate) => candidate.members.some((member) => member.paneId === pane.id));
    if (!run) return 'The merged pane has no recoverable Team run';
    try {
      const error = await this.complete(run);
      if (error && run.mergeIntent) this.reportFailure(run.id, error);
      return error;
    } finally {
      this.publishing.delete(run.id);
    }
  }

  async waitForRecovery(): Promise<void> {
    await this.recovery;
  }

  beginHook(pane: MuxBasePane): string {
    const run = this.hookRun(pane);
    const intent = run.mergeIntent;
    if (!intent || intent.state !== 'cleaned') throw new Error('Complete durable Team publication before launching its hook.');
    if (intent.hook) throw new Error('The Team post-merge hook already has a durable attempt or outcome; it will not be repeated.');
    this.ledger.commit(run.id, { hook: { at: Date.now(), state: 'running' }, operationId: intent.operationId, type: 'merge-hook' });
    this.hooking.add(run.id);
    return intent.operationId;
  }

  completeHook(pane: MuxBasePane, error?: string): void {
    const run = this.hookRun(pane);
    const intent = run.mergeIntent;
    if (!intent || intent.hook?.state !== 'running') throw new Error('The post-merge hook has no reserved Team attempt.');
    try {
      this.ledger.transaction(run.id, () => {
        this.ledger.commit(run.id, {
          hook: { at: Date.now(), error, state: error ? 'failed' : 'succeeded' },
          operationId: intent.operationId,
          type: 'merge-hook',
        });
        this.ledger.commit(run.id, { error, status: 'merged', type: 'status' });
        if (error) this.ledger.lead(run.id, error);
      });
    } finally {
      this.hooking.delete(run.id);
    }
  }

  private hookRun(pane: MuxBasePane): TeamRun {
    const run = this.ledger.list().find((candidate) => candidate.mergeIntent?.sourcePaneId === pane.id && candidate.status === 'merged');
    if (!run) throw new Error('The post-merge hook has no durably published Team source.');
    return run;
  }

  isPublishing(runId: string): boolean {
    return this.publishing.has(runId);
  }

  recover(): Promise<void> {
    this.recovery ??= this.dependencies.runProjectMutation(() => this.recoverAll())
      .finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  private async recoverAll(): Promise<void> {
    for (const run of this.ledger.list()) {
      if (!run.mergeIntent || this.publishing.has(run.id) || this.hooking.has(run.id)) continue;
      const error = await this.complete(run);
      if (error) this.reportFailure(run.id, error);
      else this.reconcileHook(this.ledger.get(run.id));
    }
  }

  private reconcileHook(run: TeamRun): void {
    const intent = run.mergeIntent;
    if (!intent || (intent.hook && intent.hook.state !== 'running')) return;
    const error = 'Git merged, but the post-merge hook outcome is unknown. No durable completion is available; inspect external effects before any manual retry. Recovery will not repeat the hook.';
    this.ledger.transaction(run.id, () => {
      this.ledger.commit(run.id, {
        hook: { at: Date.now(), error, state: 'unknown' }, operationId: intent.operationId, type: 'merge-hook',
      });
      this.ledger.commit(run.id, { error, status: 'merged', type: 'status' });
      this.ledger.lead(run.id, error);
    });
    log.error('team', 'Post-merge hook outcome requires attention', { operationId: intent.operationId, runId: run.id });
    this.dependencies.notify(error);
  }

  private async complete(run: TeamRun): Promise<string | null> {
    const intent = run.mergeIntent;
    if (!intent) return 'A durable Team merge intent and Git publication receipt are required.';
    if (intent.state === 'cleaned') return null;
    try {
      if (intent.state === 'prepared' && await hasCertifiedPublicationReceipt(run.projectRoot, intent, intent.sourceSha)) {
        this.recordPublished(run, intent);
      }
      await recoverCertifiedPublication(run.projectRoot, intent, intent.sourceSha);
      if (this.ledger.get(run.id).mergeIntent?.state === 'prepared') {
        if (!await hasCertifiedPublicationReceipt(run.projectRoot, intent, intent.sourceSha)) return 'Team merge publication is ambiguous: its owned Git receipt is missing. Worktrees are preserved.';
        this.recordPublished(run, intent);
      }
      const error = await this.members.cleanupPublishedMerge(run.id);
      if (!error) this.ledger.transaction(run.id, () => {
        this.ledger.commit(run.id, { intent: { ...intent, state: 'cleaned' }, type: 'merge-intent' });
        this.ledger.commit(run.id, { status: 'merged', type: 'status' });
      });
      return error;
    } catch (error) {
      return `Git publication recovery failed: ${formatError(error)}. Worktrees are preserved.`;
    }
  }

  private reportFailure(runId: string, error: string): void {
    const published = this.ledger.get(runId).mergeIntent?.state === 'published';
    this.ledger.commit(runId, { error, status: published ? 'merged' : 'failed', type: 'status' });
    log.error('team', 'Team merge recovery requires attention', { error, runId });
    this.dependencies.notify(error);
  }

  private recordPublished(run: TeamRun, intent: TeamMergeIntent): void {
    this.ledger.transaction(run.id, () => {
      this.ledger.commit(run.id, { intent: { ...intent, state: 'published' }, type: 'merge-intent' });
      this.ledger.commit(run.id, { status: 'merged', type: 'status' });
      this.ledger.lead(run.id, 'The reviewed source was published. Its durable Git receipt confirms the merge.');
    });
  }

  private async head(run: TeamRun): Promise<string> {
    return (await gitOrThrow(run.projectRoot, ['rev-parse', 'HEAD'])).trim();
  }
}

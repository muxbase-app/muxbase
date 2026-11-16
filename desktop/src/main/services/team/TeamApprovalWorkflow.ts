import type { MuxBasePane } from 'muxbase/core';
import type { TeamApproval, TeamDuelSnapshot, TeamMember, TeamRound, TeamRun } from '../../../shared/team-types.js';
import { createReviewSnapshot, gitOrThrow } from '../git/gitDiff.js';
import { changedFiles, runTeamCheck } from './teamChecks.js';
import type { TeamExecution } from './TeamExecution.js';
import type { TeamLedger } from './TeamLedger.js';
import { verifyTeamMergeSource } from './teamMergeSource.js';
import { openRound, teamDeveloper } from './teamProtocol.js';
import { captureTeamReadiness, isTeamMemberReady, revalidateTeamReadiness } from './teamReadiness.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export class TeamApprovalWorkflow {
  private readonly waitingReviewers = new Set<string>();
  constructor(
    private readonly ledger: TeamLedger,
    private readonly dependencies: TeamWorkflowDependencies,
    private readonly execution: TeamExecution,
  ) {}

  private async snapshot(run: TeamRun, developer = teamDeveloper(run)): Promise<string> {
    this.execution.assert(run);
    const token = captureTeamReadiness(this.dependencies, developer);
    const snapshot = await createReviewSnapshot(developer.worktreePath);
    this.execution.assert(this.ledger.get(run.id));
    revalidateTeamReadiness(this.dependencies, developer, token);
    if (snapshot.skippedFiles.length) throw new Error(`Snapshot omitted changed files: ${snapshot.skippedFiles.join(', ')}`);
    return snapshot.sha;
  }

  async checkCandidate(runId: string, member: TeamMember): Promise<TeamDuelSnapshot> {
    const run = this.ledger.get(runId);
    const token = captureTeamReadiness(this.dependencies, member);
    const snapshotSha = await this.snapshot(run, member);
    if (run.checkCommand) this.ledger.commit(runId, { pending: true, type: 'check-execution' });
    const result = run.checkCommand
      ? await runTeamCheck(member.worktreePath, run.checkCommand, this.execution.signal(runId))
      : { output: 'No project check command is configured; independent review is still required.', passed: true };
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, member, token);
    const fresh = await this.snapshot(run, member);
    const unchanged = await this.sameTree(member.worktreePath, snapshotSha, fresh);
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, member, token);
    if (!unchanged) throw new Error(`${member.label} changed during its checks; the comparison must be prepared again`);
    this.ledger.feed(runId, { command: run.checkCommand ?? 'No configured check', kind: 'check', output: `${member.label}: ${result.output}`, passed: result.passed });
    return { checkedSnapshot: run.checkCommand && result.passed ? snapshotSha : undefined, checksPassed: result.passed, paneId: member.paneId, snapshotSha };
  }

  async verifyCandidate(runId: string, member: TeamMember, snapshot: TeamDuelSnapshot): Promise<void> {
    const run = this.ledger.get(runId);
    if (snapshot.paneId !== member.paneId || member.readOnly) throw new Error('The candidate snapshot has inconsistent source ownership');
    const token = captureTeamReadiness(this.dependencies, member);
    const fresh = await this.snapshot(run, member);
    if (!await this.sameTree(member.worktreePath, fresh, snapshot.snapshotSha)) throw new Error(`${member.label} changed after the immutable Duel comparison snapshot`);
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, member, token);
  }

  private async sameTree(path: string, left: string, right: string): Promise<boolean> {
    const trees = await Promise.all([left, right].map((sha) => gitOrThrow(path, ['rev-parse', `${sha}^{tree}`])));
    return trees[0].trim() === trees[1].trim();
  }

  private async head(run: TeamRun): Promise<string> {
    return (await gitOrThrow(run.projectRoot, ['rev-parse', 'HEAD'])).trim();
  }

  async check(runId: string): Promise<'passed' | 'failed' | 'changed'> {
    const run = this.ledger.get(runId);
    this.ledger.commit(run.id, { type: 'check-snapshot' });
    if (!run.checkCommand) {
      this.ledger.lead(run.id, 'No check command is set for this project, so only review protects this change.');
      return 'passed';
    }
    const developer = teamDeveloper(run);
    const token = captureTeamReadiness(this.dependencies, developer);
    const sha = await this.snapshot(run);
    this.ledger.commit(runId, { pending: true, type: 'check-execution' });
    const result = await runTeamCheck(developer.worktreePath, run.checkCommand, this.execution.signal(runId));
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, developer, token);
    const fresh = await this.snapshot(run);
    const unchanged = await this.sameTree(developer.worktreePath, sha, fresh);
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, developer, token);
    const passed = result.passed && unchanged;
    this.ledger.transaction(runId, () => {
      if (passed) this.ledger.commit(runId, { sha, type: 'check-snapshot' });
      this.ledger.feed(runId, {
        command: run.checkCommand ?? '', kind: 'check', lane: passed ? 'agreed' : 'contested',
        output: unchanged ? result.output : `${result.output}\nThe source changed during checks; their result is invalid.`,
        passed,
      });
    });
    return unchanged ? (passed ? 'passed' : 'failed') : 'changed';
  }

  reviewersReady(runId: string): boolean {
    const run = this.ledger.get(runId);
    this.execution.assert(run);
    const reviewers = run.members.filter((member) => member.readOnly);
    if (!reviewers.length) throw new Error('No registered reviewers are available');
    const ready = reviewers.map((member) => isTeamMemberReady(this.dependencies, member)).every(Boolean);
    if (ready) this.waitingReviewers.delete(runId);
    else if (!this.waitingReviewers.has(runId)) {
      this.waitingReviewers.add(runId);
      this.ledger.lead(runId, 'Waiting for every reviewer to become strictly ready before preparing its snapshot. The existing run limits still apply.');
    }
    return ready;
  }

  async review(runId: string): Promise<{ sha: string; targetSha: string; reviewers: TeamMember[] }> {
    const run = this.ledger.get(runId);
    const developer = teamDeveloper(run);
    const token = captureTeamReadiness(this.dependencies, developer);
    const targetSha = await this.head(run);
    const fresh = await this.snapshot(run);
    if (run.checkCommand && (!run.checkedSnapshot || !await this.sameTree(developer.worktreePath, fresh, run.checkedSnapshot))) {
      this.revoke(run.id, 'The source no longer matches its passed checks.');
      throw new Error('Checks must pass on the exact code being reviewed');
    }
    const sha = run.checkCommand ? run.checkedSnapshot ?? fresh : fresh;
    if ((await changedFiles(run.projectRoot, run.baseSha, sha)).length === 0) throw new Error('The Developer finished without changing any code');
    const reviewers = run.members.filter((member) => member.readOnly);
    if (!reviewers.length) throw new Error('No registered reviewers are available');
    for (const member of reviewers) {
      this.execution.assert(this.ledger.get(runId));
      revalidateTeamReadiness(this.dependencies, developer, token);
      const reviewerToken = captureTeamReadiness(this.dependencies, member);
      await gitOrThrow(member.worktreePath, ['checkout', '--detach', sha]);
      this.execution.assert(this.ledger.get(runId));
      revalidateTeamReadiness(this.dependencies, member, reviewerToken);
    }
    const finalSnapshot = await this.snapshot(run);
    if (!await this.sameTree(developer.worktreePath, sha, finalSnapshot) || await this.head(run) !== targetSha) {
      throw new Error('The source or target changed while review was preparing');
    }
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, developer, token);
    return { reviewers, sha, targetSha };
  }

  async approve(runId: string, round: TeamRound): Promise<TeamApproval | null> {
    const run = this.ledger.get(runId);
    if (!round.snapshotSha || !round.targetSha) throw new Error('This review has no durable snapshot and target identity');
    const developer = teamDeveloper(run);
    const token = captureTeamReadiness(this.dependencies, developer);
    const fresh = await this.snapshot(run);
    const unchanged = await this.sameTree(developer.worktreePath, fresh, round.snapshotSha);
    const target = await this.head(run);
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, developer, token);
    if (!unchanged || target !== round.targetSha) {
      this.revoke(runId, 'The source or target changed during review.');
      return null;
    }
    if (run.checkCommand && round.snapshotSha !== run.checkedSnapshot) throw new Error('Review does not match the checked snapshot');
    this.execution.assert(this.ledger.get(runId));
    return {
      at: Date.now(), checkedSnapshot: run.checkedSnapshot, kind: 'review',
      snapshotSha: round.snapshotSha, sourcePaneId: developer.paneId, targetSha: round.targetSha,
    };
  }

  async waiver(runId: string, decisionId: string, reason: string): Promise<TeamApproval> {
    if (!reason.trim()) throw new Error('Accept as is requires a nonempty waiver reason');
    const run = this.ledger.get(runId);
    const token = captureTeamReadiness(this.dependencies, teamDeveloper(run));
    const targetSha = await this.head(run);
    const snapshotSha = await this.snapshot(run);
    if (!(await changedFiles(run.projectRoot, run.baseSha, snapshotSha)).length) throw new Error('There is no changed code to accept');
    const fresh = await this.snapshot(run);
    if (!await this.sameTree(teamDeveloper(run).worktreePath, snapshotSha, fresh) || await this.head(run) !== targetSha) {
      throw new Error('The source or target changed while accepting the waiver');
    }
    this.execution.assert(this.ledger.get(runId));
    revalidateTeamReadiness(this.dependencies, teamDeveloper(run), token);
    return { at: Date.now(), decisionId, kind: 'waiver', reason: reason.trim(), snapshotSha, sourcePaneId: teamDeveloper(run).paneId, targetSha };
  }

  revoke(runId: string, reason: string): void {
    this.ledger.transaction(runId, () => {
      const round = openRound(this.ledger.get(runId));
      if (round) this.ledger.commit(runId, { outcome: 'failed', roundId: round.id, type: 'round-closed' });
      this.ledger.commit(runId, { type: 'approved' });
      this.ledger.commit(runId, { type: 'check-snapshot' });
      this.ledger.commit(runId, { stage: 'review', type: 'stage' });
      this.ledger.commit(runId, { status: 'running', type: 'status' });
      this.ledger.commit(runId, { next: 'check', type: 'next' });
      this.ledger.lead(runId, `${reason} Approval was revoked; checks and review reopen.`);
    });
  }

  async validate(pane: MuxBasePane, worktreePath?: string, sourceRevision?: string): Promise<string | null> {
    const known = this.execution.runs().find((run) => run.members.some((member) => member.paneId === pane.id));
    const run = pane.teamRunId ? this.ledger.find(pane.teamRunId) : known;
    if (!run) return pane.teamRunId ? 'The pane’s team run could not be recovered; merging is blocked' : null;
    if (known && known.id !== run.id) return 'The pane’s team membership is inconsistent';
    try {
      const member = this.registeredDeveloper(run, pane, worktreePath);
      const certificate = this.certificate(run);
      this.execution.assert(run);
      const token = captureTeamReadiness(this.dependencies, member);
      const fresh = await this.snapshot(run);
      const unchanged = await this.sameTree(member.worktreePath, certificate.snapshotSha, fresh);
      const target = await this.head(run);
      this.execution.assert(this.ledger.get(run.id));
      revalidateTeamReadiness(this.dependencies, member, token);
      if (target !== certificate.targetSha || !unchanged) {
        this.revoke(run.id, target !== certificate.targetSha ? 'The merge target changed.' : 'The code changed after approval.');
        return 'Approval drifted; the team must check and review the integrated code again';
      }
      await verifyTeamMergeSource(pane, member.worktreePath, certificate.snapshotSha, sourceRevision);
      if (await this.head(run) !== certificate.targetSha) {
        this.revoke(run.id, 'The merge target changed during source verification.');
        return 'Approval drifted; the team must check and review the integrated code again';
      }
      this.execution.assert(this.ledger.get(run.id));
      revalidateTeamReadiness(this.dependencies, member, token);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Snapshot omitted')) this.revoke(run.id, message);
      return message;
    }
  }

  private registeredDeveloper(run: TeamRun, pane: MuxBasePane, worktreePath?: string): TeamMember {
    const member = run.members.find((candidate) => candidate.paneId === pane.id);
    if (!member || member.paneId !== teamDeveloper(run).paneId || member.readOnly) throw new Error('Only the selected registered team source can merge');
    if (worktreePath && worktreePath !== member.worktreePath) throw new Error('Nested repositories have no team approval certificate');
    if (pane.worktreePath !== member.worktreePath || pane.projectRoot !== run.projectRoot) throw new Error('The Developer worktree or project identity changed');
    return member;
  }

  private certificate(run: TeamRun): TeamApproval {
    if (run.status !== 'ready') throw new Error('This team run is not ready to merge');
    if (!run.approval || run.approval.snapshotSha !== run.approvedSnapshot) throw new Error('A valid team approval certificate is required');
    const certificate = run.approval;
    if (run.mode === 'duel' && (!run.selectedSourceId || certificate.sourcePaneId !== run.selectedSourceId)) throw new Error('Duel approval must bind the human-selected source');
    if (certificate.kind === 'waiver' && !certificate.reason?.trim()) throw new Error('The waiver has no reason');
    if (certificate.kind === 'review' && run.checkCommand && (certificate.checkedSnapshot !== certificate.snapshotSha || run.checkedSnapshot !== certificate.checkedSnapshot)) throw new Error('Approval does not certify the checked code');
    return certificate;
  }
}

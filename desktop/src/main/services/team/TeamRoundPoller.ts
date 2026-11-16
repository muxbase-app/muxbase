import { getProjectMetadataDir, type MuxBasePane } from 'muxbase/core';
import { basename } from 'path';
import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import { isReadyForMutation, type PaneActivity } from '../../../shared/pane-activity.js';
import { lastAssistantText } from '../../../shared/review-findings.js';
import type { TeamMember, TeamRoleId, TeamRound, TeamRun } from '../../../shared/team-types.js';
import type { TeamLedger } from './TeamLedger.js';
import { parseTeamPosition } from './teamPositions.js';
import { buildReminder, buildRoundMessage, roundFilePath } from './teamPrompts.js';
import { normalizeSupport } from './teamProtocol.js';
import { captureTeamReadiness } from './teamReadiness.js';

const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const LAST_MESSAGE_MAX_CHARS = 60_000;
const MISSING_PANE_GRACE_MS = 60_000;

export interface TeamPaneAccess {
  clearStartupPrompt(paneId: string): Promise<void>;
  getPane(paneId: string): MuxBasePane | undefined;
  getPaneActivity(paneId: string): PaneActivity | undefined;
  getSession(paneId: string): NormalizedSession | null;
  sendPromptToPane(paneId: string, prompt: string): Promise<void>;
}

function sessionBaseline(round: TeamRound, role: TeamRoleId, session: NormalizedSession | null): number {
  const deliveredSession = round.deliveryAttempts?.[role]?.sessionId;
  return deliveredSession && session && deliveredSession !== session.sessionId ? 0 : (round.baselines[role] ?? 0);
}

function canReceivePrompt(activity: PaneActivity | undefined, session: NormalizedSession | null): boolean {
  return isReadyForMutation(activity) && !session?.isOngoing && !session?.awaitingUserInput;
}

function answeredSince(session: NormalizedSession | null, baseline: number, since?: number): boolean {
  if (!session || session.isOngoing || session.awaitingUserInput) return false;
  return session.messages.slice(baseline).some((message) => message.type === 'assistant' && message.content.trim() && (!since || !message.timestamp || message.timestamp >= since));
}

export function teamRoundPath(run: TeamRun, roundId: string): string {
  return roundFilePath(basename(getProjectMetadataDir(run.projectRoot)), roundId);
}

export class TeamRoundPoller {
  private readonly missingSince = new Map<string, number>();

  constructor(
    private readonly ledger: TeamLedger,
    private readonly panes: TeamPaneAccess,
  ) {}

  async poll(runId: string, roundId: string): Promise<TeamRound | undefined> {
    const participants = this.round(runId, roundId)?.participants ?? [];
    for (const role of participants) await this.pollMember(runId, roundId, role);
    const refreshed = this.round(runId, roundId);
    const settled = refreshed?.participants.every((role) => refreshed.positions[role] || refreshed.failures[role]);
    return settled ? refreshed : undefined;
  }

  private round(runId: string, roundId: string): TeamRound | undefined {
    return this.ledger.get(runId).rounds.find((candidate) => candidate.id === roundId);
  }

  private async pollMember(runId: string, roundId: string, role: TeamRoleId): Promise<void> {
    const run = this.ledger.get(runId);
    const round = this.round(runId, roundId);
    const member = run.members.find((candidate) => candidate.role === role);
    if (run.status !== 'running' || !round || !member || round.positions[role] || round.failures[role]) return;
    if (this.paneIsGone(runId, round, member)) return;
    const session = this.panes.getSession(member.paneId);
    const activity = this.panes.getPaneActivity(member.paneId);
    if (round.deliveryAttempts?.[role]?.state === 'pending') {
      this.fail(runId, round, member, `The ${member.label} delivery was interrupted. It may already have received the prompt; retry requires a new attempt.`);
      return;
    }
    if (round.undelivered.includes(role)) {
      await this.deliver(run, round, member, session, activity);
      return;
    }
    const baseline = sessionBaseline(round, role, session);
    const settled = canReceivePrompt(activity, session) && answeredSince(session, baseline, round.deliveryAttempts?.[role]?.at);
    const reply = session ? { ...session, messages: session.messages.slice(baseline) } : null;
    const position = settled ? parseTeamPosition(lastAssistantText(reply, LAST_MESSAGE_MAX_CHARS) ?? '', round.id, round.kind, round.kind === 'design' && round.number === 1) : null;
    if (position) {
      this.ledger.commit(runId, { position: normalizeSupport(run, round, role, position), role, roundId, type: 'position' });
      return;
    }
    await this.chase(run, round, member, session, activity);
  }

  private paneIsGone(runId: string, round: TeamRound, member: TeamMember): boolean {
    if (this.panes.getPane(member.paneId)) {
      this.missingSince.delete(member.paneId);
      return false;
    }
    const firstMissed = this.missingSince.get(member.paneId) ?? Date.now();
    this.missingSince.set(member.paneId, firstMissed);
    if (Date.now() - firstMissed > MISSING_PANE_GRACE_MS) {
      this.fail(runId, round, member, `The ${member.label} pane was closed.`);
    }
    return true;
  }

  private timedOut(round: TeamRound, session: NormalizedSession | null): boolean {
    const lastProgress = Math.max(round.openedAt, session?.lastUpdateTime ?? 0);
    return Date.now() - lastProgress > TURN_TIMEOUT_MS;
  }

  private async chase(
    run: TeamRun,
    round: TeamRound,
    member: TeamMember,
    session: NormalizedSession | null,
    activity: PaneActivity | undefined,
  ): Promise<void> {
    if (this.timedOut(round, session)) {
      this.fail(run.id, round, member, `The ${member.label} went 30 minutes without progress.`);
      return;
    }
    const baseline = sessionBaseline(round, member.role, session);
    const answered = answeredSince(session, baseline, round.deliveryAttempts?.[member.role]?.at);
    if (!session && baseline === 0 && canReceivePrompt(activity, session)) await this.panes.clearStartupPrompt(member.paneId);
    if (!canReceivePrompt(activity, session) || !answered) return;
    if (round.reminded.includes(member.role)) {
      this.fail(run.id, round, member, `The ${member.label} did not return a valid position twice.`);
      return;
    }
    await this.send(run, round, member, session, buildReminder(teamRoundPath(run, round.id)));
    if (this.ledger.get(run.id).status !== 'running') return;
    this.ledger.commit(run.id, { role: member.role, roundId: round.id, type: 'reminded' });
  }

  private async deliver(
    run: TeamRun,
    round: TeamRound,
    member: TeamMember,
    session: NormalizedSession | null,
    activity: PaneActivity | undefined,
  ): Promise<void> {
    if (!canReceivePrompt(activity, session)) {
      if (this.timedOut(round, session)) this.fail(run.id, round, member, `The ${member.label} never became ready for this round.`);
      return;
    }
    await this.send(run, round, member, session, buildRoundMessage(teamRoundPath(run, round.id)));
  }

  private async send(run: TeamRun, round: TeamRound, member: TeamMember, session: NormalizedSession | null, prompt: string): Promise<void> {
    if (this.ledger.get(run.id).status !== 'running') return;
    const before = captureTeamReadiness(this.panes, member);
    this.ledger.transaction(run.id, () => {
      this.markDelivered(run.id, round, member, session);
      this.ledger.commit(run.id, { role: member.role, roundId: round.id, sessionId: session?.sessionId, state: 'pending', type: 'delivery-attempt' });
    });
    await this.panes.sendPromptToPane(member.paneId, prompt);
    const after = this.panes.getPaneActivity(member.paneId);
    if (!after || after.paneIncarnationId !== before.paneIncarnationId) throw new Error(`The ${member.label} pane changed during prompt delivery; the attempt is ambiguous`);
    this.ledger.commit(run.id, { role: member.role, roundId: round.id, state: 'sent', type: 'delivery-attempt' });
  }

  private markDelivered(runId: string, round: TeamRound, member: TeamMember, session: NormalizedSession | null): void {
    this.ledger.commit(runId, {
      baseline: session?.messages.length ?? 0,
      role: member.role,
      roundId: round.id,
      type: 'delivered',
    });
  }

  private fail(runId: string, round: TeamRound, member: TeamMember, reason: string): void {
    this.ledger.commit(runId, { reason, role: member.role, roundId: round.id, type: 'member-failed' });
  }
}

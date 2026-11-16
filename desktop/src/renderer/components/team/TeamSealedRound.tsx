import { Check, Lock } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { TeamRoleId, TeamRound, TeamRun } from '../../../shared/team-types';
import { formatAgentLabel } from '../../lib/formatters';
import { usePaneActivityStore } from '../../stores';
import { isRunLive, memberFor, ROLE_COLORS, roleMark, roleName, roundQuestion } from './teamViewModel';

function answeredStatus(round: TeamRound, role: TeamRoleId): string | undefined {
  if (round.failures[role]) return 'No answer';
  if (!round.positions[role]) return undefined;
  return round.kind === 'build' ? 'Build reported' : 'Sealed';
}

function runStatus(run: TeamRun, role: TeamRoleId): string | undefined {
  if (run.status === 'stopping') return 'Stopping';
  if (!isRunLive(run)) return 'Stopped';
  return memberFor(run, role) ? undefined : 'Starting';
}

function activityStatus(round: TeamRound, role: TeamRoleId, activityState: string | undefined): string {
  if (activityState === 'stopped') return 'Agent exited; retry required';
  if (round.undelivered.includes(role)) return 'Waiting for confirmed readiness';
  if (activityState === 'waiting') return 'Waiting in its pane';
  if (activityState === 'working') return round.kind === 'design' ? 'Thinking alone' : 'Working';
  return 'Waiting for a reply';
}

function sealStatus(run: TeamRun, round: TeamRound, role: TeamRoleId, activityState: string | undefined): string {
  return answeredStatus(round, role) ?? runStatus(run, role) ?? activityStatus(round, role, activityState);
}

function roundStatus(round: TeamRound, run: TeamRun): string {
  if (run.status === 'stopping') return 'Stopping before reveal';
  if (!isRunLive(run)) return 'Stopped before reveal';
  return round.kind === 'build' ? 'Build in progress' : 'Sealed until all are in';
}

function SealRow({ role, round, run }: Readonly<{ role: TeamRoleId; round: TeamRound; run: TeamRun }>) {
  const member = memberFor(run, role);
  const activityState = usePaneActivityStore((s) => s.activityByPaneId[member?.paneId ?? '']?.state);
  const status = sealStatus(run, round, role, activityState);
  const answered = Boolean(round.positions[role]);
  const thinking = !answered && activityState === 'working' && run.status !== 'stopping' && isRunLive(run);
  return (
    <li className="team-sealed-row" data-testid={`team-seal-${role}`} style={{ '--c': ROLE_COLORS[role] } as CSSProperties}>
      <span aria-hidden="true" className="team-mark">{roleMark(run, role)}</span>
      <span className="team-sealed-who">{roleName(run, role)}{member && <small>{formatAgentLabel(member.agent)}</small>}</span>
      <span className={answered ? 'team-sealed-state ok' : 'team-sealed-state'}>
        {answered && <Check aria-hidden="true" />}
        {thinking && <span aria-hidden="true" className="team-dots"><i /><i /><i /></span>}
        {status}
      </span>
    </li>
  );
}

export function TeamSealedRound({ round, run }: Readonly<{ round: TeamRound; run: TeamRun }>) {
  const answered = round.participants.filter((role) => round.positions[role]).length;
  return (
    <div className="team-sealed" data-round-kind={round.kind} data-testid="team-round">
      <header>
        <Lock aria-hidden="true" />
        {roundStatus(round, run)}
        <span>{answered} of {round.participants.length}</span>
      </header>
      <p>{roundQuestion(round)}</p>
      <ul>
        {round.participants.map((role) => <SealRow key={role} role={role} round={round} run={run} />)}
      </ul>
    </div>
  );
}

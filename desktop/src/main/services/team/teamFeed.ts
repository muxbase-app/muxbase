import type {
  TeamFeedItem,
  TeamPosition,
  TeamRoleId,
  TeamRound,
  TeamRun,
} from '../../../shared/team-types.js';
import { latestProposal, memberLabel } from './teamProtocol.js';

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type TeamFeedDraft = DistributiveOmit<TeamFeedItem, 'at' | 'id'>;

function message(
  role: TeamRoleId,
  label: string,
  text: string,
  evidence: string[],
  lane?: TeamFeedDraft['lane'],
  reply = false,
): TeamFeedDraft {
  return { evidence, kind: 'message', label, lane, reply, role, text };
}

function responseDrafts(run: TeamRun, role: TeamRoleId, position: TeamPosition): TeamFeedDraft[] {
  return position.responses.map((response) => {
    const conceded = response.kind === 'concede';
    return message(
      role,
      conceded ? 'Concedes' : 'Rebuts',
      `${memberLabel(run, response.to)}: ${response.text}`,
      response.evidence,
      conceded ? 'agreed' : 'contested',
      true,
    );
  });
}

function objectionDrafts(role: TeamRoleId, position: TeamPosition, label: string): TeamFeedDraft[] {
  return position.objections.map((objection) => {
    const blocking = objection.severity === 'blocking';
    return message(role, blocking ? label : 'Note', objection.claim, objection.evidence, blocking ? 'contested' : undefined, true);
  });
}

function designDrafts(run: TeamRun, round: TeamRound, role: TeamRoleId, position: TeamPosition): TeamFeedDraft[] {
  const owner = position.supports ?? role;
  const backing = owner === role ? 'Holds' : `Backs ${memberLabel(run, owner)}`;
  const title = latestProposal(run, owner)?.title;
  const headline = round.number === 1 ? [] : [
    message(role, backing, title ? `${title}. ${position.summary}` : position.summary, position.evidence, undefined),
  ];
  return [...headline, ...responseDrafts(run, role, position), ...objectionDrafts(role, position, 'Objection')];
}

function reviewDrafts(role: TeamRoleId, position: TeamPosition): TeamFeedDraft[] {
  const approved = position.verdict === 'approve';
  return [
    message(role, approved ? 'Approves' : 'Blocks', position.summary, position.evidence, approved ? 'agreed' : 'contested'),
    ...objectionDrafts(role, position, 'Blocks'),
  ];
}

function buildDrafts(run: TeamRun, role: TeamRoleId, position: TeamPosition): TeamFeedDraft[] {
  return [
    message(role, 'Delivered', position.summary, position.evidence, 'working'),
    ...responseDrafts(run, role, position),
  ];
}

function memberDrafts(run: TeamRun, round: TeamRound, role: TeamRoleId): TeamFeedDraft[] {
  const position = round.positions[role];
  if (!position) return [];
  if (round.kind === 'design') return designDrafts(run, round, role, position);
  if (round.kind === 'review') return reviewDrafts(role, position);
  return buildDrafts(run, role, position);
}

export function roundFeed(run: TeamRun, round: TeamRound): TeamFeedDraft[] {
  return round.participants.flatMap((role) => memberDrafts(run, round, role));
}

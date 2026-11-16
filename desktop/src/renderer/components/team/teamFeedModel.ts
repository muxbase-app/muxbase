import type { TeamFeedItem, TeamRoleId, TeamRound, TeamRoundKind, TeamRoundOutcome, TeamRun } from '../../../shared/team-types';
import { decisionOutcome } from './teamViewModel';

export type MessageItem = Extract<TeamFeedItem, { kind: 'message' }>;
export type CheckItem = Extract<TeamFeedItem, { kind: 'check' }>;
type RoundItem = Extract<TeamFeedItem, { kind: 'round' }>;

export type FeedBlock =
  | { items: CheckItem[]; key: string; kind: 'checks' }
  | { item: TeamFeedItem; key: string; kind: 'entry' }
  | { items: MessageItem[]; key: string; kind: 'speaker'; role: TeamRoleId };

export interface FeedSegment {
  at?: number;
  blocks: FeedBlock[];
  collapsed: boolean;
  key: string;
  pinned: FeedBlock[];
  round?: TeamRound;
  summary?: string;
  title?: string;
}

const KIND_LABELS: Record<TeamRoundKind, string> = { build: 'Build', design: 'Design', review: 'Review' };
const OUTCOME_LABELS: Record<TeamRoundOutcome, string> = {
  agreed: 'agreed',
  blocked: 'blocked',
  continue: 'no agreement yet',
  done: 'done',
  escalated: 'escalated to you',
  failed: 'a member did not answer',
};

interface DraftSegment {
  items: TeamFeedItem[];
  key: string;
  marker?: RoundItem;
}

export function historyItems(run: TeamRun, openDecisionId: string | undefined): TeamFeedItem[] {
  return run.feed.filter((item) => {
    if (item.kind === 'final') return false;
    if (item.kind === 'decision') return item.decisionId !== openDecisionId;
    return item.kind !== 'lead' || item.text !== run.error;
  });
}

function splitByRound(items: TeamFeedItem[]): DraftSegment[] {
  const segments: DraftSegment[] = [{ items: [], key: 'start' }];
  for (const item of items) {
    if (item.kind === 'round') segments.push({ items: [], key: item.id, marker: item });
    else segments[segments.length - 1].items.push(item);
  }
  return segments.filter((segment) => segment.marker || segment.items.length > 0);
}

function appendTo(previous: FeedBlock | undefined, item: TeamFeedItem): boolean {
  if (previous?.kind === 'checks' && item.kind === 'check') {
    previous.items.push(item);
    return true;
  }
  if (previous?.kind === 'speaker' && item.kind === 'message' && previous.role === item.role) {
    previous.items.push(item);
    return true;
  }
  return false;
}

function startBlock(item: TeamFeedItem): FeedBlock {
  if (item.kind === 'check') return { items: [item], key: item.id, kind: 'checks' };
  if (item.kind === 'message') return { items: [item], key: item.id, kind: 'speaker', role: item.role };
  return { item, key: item.id, kind: 'entry' };
}

function groupBlocks(items: TeamFeedItem[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  for (const item of items) {
    if (!appendTo(blocks.at(-1), item)) blocks.push(startBlock(item));
  }
  return blocks;
}

function roundTitle(round: TeamRound): string {
  return `Round ${round.number} · ${round.comparison ? 'Compare' : KIND_LABELS[round.kind]}`;
}

function isPinned(block: FeedBlock): boolean {
  return block.kind === 'checks' || (block.kind === 'entry' && (block.item.kind === 'decision' || block.item.kind === 'human'));
}

function decidedSummary(run: TeamRun, round: TeamRound): string | undefined {
  const decision = run.decisions.filter((candidate) => candidate.roundId === round.id && candidate.chosen).at(-1);
  return decision && `Decided by you: ${decisionOutcome(decision)}`;
}

function roundSummary(run: TeamRun, round: TeamRound, items: TeamFeedItem[]): string {
  const decided = decidedSummary(run, round);
  if (decided) return decided;
  const agreed = items.filter((item) => item.kind === 'agreed').at(-1);
  if (agreed?.kind === 'agreed') return agreed.title;
  if (!round.closedAt) return 'in progress';
  const answered = round.participants.filter((role) => round.positions[role]).length;
  const counts = `${answered} of ${round.participants.length} answered`;
  return round.outcome ? `${OUTCOME_LABELS[round.outcome]} · ${counts}` : counts;
}

function toSegment(run: TeamRun, draft: DraftSegment, latestRoundKey: string | undefined, visible: (item: TeamFeedItem) => boolean): FeedSegment {
  const round = draft.marker ? run.rounds.find((candidate) => candidate.id === draft.marker?.roundId) : undefined;
  const blocks = groupBlocks(draft.items.filter(visible));
  const collapsed = Boolean(round?.closedAt) && draft.key !== latestRoundKey;
  return {
    at: draft.marker?.at,
    blocks: collapsed ? blocks.filter((block) => !isPinned(block)) : blocks,
    collapsed,
    key: draft.key,
    pinned: collapsed ? blocks.filter(isPinned) : [],
    round,
    summary: round && roundSummary(run, round, draft.items),
    title: round && roundTitle(round),
  };
}

export function feedSegments(run: TeamRun, items: TeamFeedItem[], visible: (item: TeamFeedItem) => boolean = () => true): FeedSegment[] {
  const drafts = splitByRound(items);
  const latestRoundKey = drafts.filter((draft) => draft.marker).at(-1)?.key;
  return drafts.map((draft) => toSegment(run, draft, latestRoundKey, visible));
}

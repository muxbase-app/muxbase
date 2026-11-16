import { describe, expect, it } from 'vitest';
import { feedSegments, historyItems } from '../../src/renderer/components/team/teamFeedModel';
import type { TeamFeedItem, TeamRoleId, TeamRound } from '../../src/shared/team-types';
import { teamRun } from './team-test-support';

function round(id: string, number: number, closedAt: number): TeamRound {
  return {
    baselines: {}, closedAt, failures: {}, id, kind: 'design', notes: [], number, openedAt: number, outcome: 'escalated',
    participants: ['architect', 'developer'], positions: {}, reminded: [], undelivered: [],
  };
}

function message(id: string, role: TeamRoleId): TeamFeedItem {
  return { at: 2, evidence: [], id, kind: 'message', label: 'Proposes', reply: false, role, text: id };
}

const AGREED_TITLE = 'Schema first';

const run = teamRun({
  error: 'Publication failed',
  feed: [
    { at: 0, id: 'intro', kind: 'lead', text: 'Everyone answers alone first.' },
    { at: 1, id: 'marker-1', kind: 'round', roundId: 'round-1' },
    message('a1', 'architect'),
    message('a2', 'architect'),
    message('d1', 'developer'),
    message('a3', 'architect'),
    { at: 4, command: 'pnpm test', id: 'check-1', kind: 'check', passed: true },
    { at: 5, decisionId: 'decision-1', id: 'decided', kind: 'decision' },
    { at: 5, id: 'you', kind: 'human', text: 'Keep schemas in the API package.' },
    { at: 6, id: 'marker-2', kind: 'round', roundId: 'round-2' },
    { at: 7, id: 'agreed', kind: 'agreed', text: 'Both agree', title: AGREED_TITLE, votes: '2 of 2' },
    { at: 8, id: 'error-echo', kind: 'lead', text: 'Publication failed' },
    { at: 9, id: 'final', kind: 'final' },
  ],
  decisions: [{
    chosen: 'schema', id: 'decision-1', kind: 'design', label: 'D-1', openedAt: 5,
    options: [{ holders: [], id: 'schema', title: 'Schema at the boundary' }], roundId: 'round-1', settled: [], title: 'Pick a design', why: 'Split',
  }],
  rounds: [round('round-1', 1, 5), round('round-2', 2, 9)],
});
const segments = feedSegments(run, historyItems(run, undefined));

describe('Team feed model', () => {
  it('splits the feed at round markers and titles each round with real data', () => {
    expect(segments.map((segment) => segment.key)).toEqual(['start', 'marker-1', 'marker-2']);
    expect(segments.map((segment) => segment.title)).toEqual([undefined, 'Round 1 · Design', 'Round 2 · Design']);
    expect(segments[1].summary).toBe('Decided by you: Schema at the boundary');
    expect(segments[2].summary).toBe(AGREED_TITLE);
    expect(feedSegments(run, historyItems(run, undefined), () => false)[2].summary).toBe(AGREED_TITLE);
  });

  it('groups consecutive messages from the same speaker only', () => {
    const speakers = segments[1].blocks.map((block) => block.kind === 'speaker' ? [block.role, block.items.map((item) => item.id)] : block.kind);

    expect(speakers).toEqual([['architect', ['a1', 'a2']], ['developer', ['d1']], ['architect', ['a3']]]);
  });

  it('collapses closed rounds except the latest and keeps checks, your decisions and your notes visible', () => {
    expect(segments.map((segment) => segment.collapsed)).toEqual([false, true, false]);
    expect(segments[1].pinned.map((block) => block.key)).toEqual(['check-1', 'decided', 'you']);
    expect(segments[2].pinned).toEqual([]);
  });

  it('drops the final marker, the open decision, and a lead line that repeats the run error', () => {
    const items = historyItems({ ...run, feed: [...run.feed, { at: 10, decisionId: 'open', id: 'decision', kind: 'decision' }] }, 'open');

    expect(items.map((item) => item.id)).not.toContain('error-echo');
    expect(items.map((item) => item.id)).not.toContain('final');
    expect(items.map((item) => item.id)).not.toContain('decision');
    expect(items.map((item) => item.id)).toContain('intro');
  });
});

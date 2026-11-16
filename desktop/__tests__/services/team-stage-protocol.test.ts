import { describe, expect, it } from 'vitest';
import type { TeamPosition, TeamRound, TeamRoundKind, TeamRun } from '../../src/shared/team-types.js';
import { humanDecision } from '../../src/main/services/team/teamDecisions.js';
import { parseTeamPosition } from '../../src/main/services/team/teamPositions.js';
import { buildRoundFile } from '../../src/main/services/team/teamPrompts.js';
import * as protocol from '../../src/main/services/team/teamProtocol.js';

function position(change: Partial<TeamPosition> = {}): TeamPosition {
  return { acceptable: [], evidence: [], objections: [], responses: [], summary: 'My position', ...change };
}

function run(): TeamRun {
  return protocol.reduceTeamEvent(null, {
    seed: {
      baseSha: 'base',
      brief: 'The brief',
      createdAt: 100,
      id: 'run',
      policy: 'when-stuck',
      projectRoot: '/project',
      title: 'The run',
    },
    type: 'created',
  }, 100);
}

function round(kind: TeamRoundKind = 'design'): TeamRound {
  return {
    baselines: {},
    failures: {},
    id: 'round-2',
    kind,
    notes: [],
    number: 2,
    openedAt: 200,
    participants: ['architect', 'developer'],
    positions: {
      architect: position({ supports: 'architect' }),
      developer: position({ supports: 'architect' }),
    },
    reminded: [],
    undelivered: [],
  };
}

const proposal = { cost: 'Small', gain: 'Useful', risk: 'Low', summary: 'Actual design', title: 'Proposal' };

describe('deterministic team reduction', () => {
  it('uses the persisted timestamp when closing a round', () => {
    const opened = protocol.reduceTeamEvent(run(), { round: round(), type: 'round-opened' }, 200);

    const closed = protocol.reduceTeamEvent(opened, { outcome: 'agreed', roundId: 'round-2', type: 'round-closed' }, 300);

    expect(closed.rounds[0].closedAt).toBe(300);
  });

  it('rejects a round event referencing an unknown round', () => {
    expect(() => protocol.reduceTeamEvent(run(), {
      outcome: 'done',
      roundId: 'missing',
      type: 'round-closed',
    }, 200)).toThrow(/round/i);
  });

  it('replaces recovered members by role rather than duplicating them', () => {
    const member = { agent: 'claude' as const, label: 'Architect', paneId: 'old', readOnly: true, role: 'architect' as const, worktreePath: '/worktree' };
    const initial = protocol.reduceTeamEvent(run(), { member, type: 'member' }, 200);

    const recovered = protocol.reduceTeamEvent(initial, { member: { ...member, paneId: 'new' }, type: 'member' }, 300);

    expect(recovered.members).toEqual([{ ...member, paneId: 'new' }]);
  });

  it('keeps roster order stable when replacing one recovered member', () => {
    const architect = { agent: 'claude' as const, label: 'Architect', paneId: 'old', readOnly: true, role: 'architect' as const, worktreePath: '/architect' };
    const developer = { ...architect, label: 'Developer', paneId: 'developer', role: 'developer' as const, worktreePath: '/developer' };
    let initial = protocol.reduceTeamEvent(run(), { member: architect, type: 'member' }, 200);
    initial = protocol.reduceTeamEvent(initial, { member: developer, type: 'member' }, 210);

    const recovered = protocol.reduceTeamEvent(initial, { member: { ...architect, paneId: 'new' }, type: 'member' }, 220);

    expect(recovered.members).toEqual([{ ...architect, paneId: 'new' }, developer]);
  });

  it('preserves structured approval, its legacy mirror, and clears both on revocation', () => {
    const approval = { at: 200, checkedSnapshot: 'checked', kind: 'review' as const, snapshotSha: 'snapshot', targetSha: 'target' };

    const approved = protocol.reduceTeamEvent(run(), { approval, type: 'approved' }, 200);
    const revoked = protocol.reduceTeamEvent(approved, { type: 'approved' }, 300);

    expect(approved.approval).toEqual(approval);
    expect(approved.approvedSnapshot).toBe('snapshot');
    expect(revoked.approval).toBeUndefined();
    expect(revoked.approvedSnapshot).toBeUndefined();
  });

  it('reduces check snapshot, recovery, and incremental usage deltas', () => {
    let current = protocol.reduceTeamEvent(run(), { sha: 'checked', type: 'check-snapshot' }, 200);
    current = protocol.reduceTeamEvent(current, { step: 'build', type: 'recovery' }, 210);
    current = protocol.reduceTeamEvent(current, { tokens: 15, type: 'usage' }, 220);
    current = protocol.reduceTeamEvent(current, { tokens: 5, type: 'usage' }, 230);

    expect(current.checkedSnapshot).toBe('checked');
    expect(current.recoveryStep).toBe('build');
    expect(current.tokenUsage).toBe(20);
  });

  it('persists usage checkpoint snapshots without changing additive token accounting', () => {
    const checkpoints = { 'developer:pane:old-session': 10 };
    let current = protocol.reduceTeamEvent(run(), { checkpoints, tokens: 10, type: 'usage' }, 200);
    checkpoints['developer:pane:old-session'] = 999;

    expect(current.usageCheckpoints).toEqual({ 'developer:pane:old-session': 10 });
    current = protocol.reduceTeamEvent(current, {
      checkpoints: { 'developer:pane:new-session': 0, 'developer:pane:old-session': 10 },
      tokens: 0,
      type: 'usage',
    }, 210);
    current = protocol.reduceTeamEvent(current, { tokens: 5, type: 'usage' }, 220);

    expect(current.usageCheckpoints).toEqual({ 'developer:pane:new-session': 0, 'developer:pane:old-session': 10 });
    expect(current.tokenUsage).toBe(15);
  });

  it('records delivery intent and completion using persisted timestamps', () => {
    const opened = protocol.reduceTeamEvent(run(), { round: round(), type: 'round-opened' }, 200);
    const pending = protocol.reduceTeamEvent(opened, {
      role: 'architect',
      roundId: 'round-2',
      state: 'pending',
      type: 'delivery-attempt',
    }, 210);
    const sent = protocol.reduceTeamEvent(pending, {
      role: 'architect',
      roundId: 'round-2',
      state: 'sent',
      type: 'delivery-attempt',
    }, 220);

    expect(pending.rounds[0].deliveryAttempts?.architect).toEqual({ at: 210, state: 'pending' });
    expect(sent.rounds[0].deliveryAttempts?.architect).toEqual({ at: 210, state: 'sent' });
  });

  it.each(['merged', 'stopped'] as const)('cannot resurrect a %s run with late decision resolution', (status) => {
    const closed = protocol.reduceTeamEvent(run(), { status, type: 'status' }, 200);

    const late = protocol.reduceTeamEvent(closed, { chosen: 'retry', decisionId: 'decision', type: 'decision-resolved' }, 300);

    expect(late.status).toBe(status);
  });

  it('prevents transitions while stopping but permits final closure', () => {
    const stopping = protocol.reduceTeamEvent(run(), { status: 'stopping', type: 'status' }, 200);
    let late = protocol.reduceTeamEvent(stopping, { round: round(), type: 'round-opened' }, 210);
    late = protocol.reduceTeamEvent(late, { next: 'build', type: 'next' }, 220);
    late = protocol.reduceTeamEvent(late, { stage: 'build', type: 'stage' }, 230);
    late = protocol.reduceTeamEvent(late, { status: 'running', type: 'status' }, 240);

    expect(late.status).toBe('stopping');
    expect(late.rounds).toEqual([]);
    expect(late.next).toBeUndefined();
    expect(late.stage).toBe('design');
    expect(protocol.reduceTeamEvent(late, { status: 'stopped', type: 'status' }, 250).status).toBe('stopped');
  });

  it('retains cleanup errors while stopping and permits merged cleanup completion', () => {
    const stopping = protocol.reduceTeamEvent(run(), { status: 'stopping', type: 'status' }, 200);
    const failedCleanup = protocol.reduceTeamEvent(stopping, { error: 'Pane cleanup failed', status: 'stopping', type: 'status' }, 210);

    expect(failedCleanup.error).toBe('Pane cleanup failed');
    expect(protocol.reduceTeamEvent(failedCleanup, { status: 'merged', type: 'status' }, 220).status).toBe('merged');
    expect(protocol.reduceTeamEvent(stopping, { status: 'failed', type: 'status' }, 230).status).toBe('stopping');
  });
});

describe('stage-specific position contracts', () => {
  function parse(value: Partial<TeamPosition>, kind?: TeamRoundKind, first = false) {
    return parseTeamPosition(`\`\`\`team-position\n${JSON.stringify({ ...position(value), round: 'round-2' })}\n\`\`\``, 'round-2', kind, first);
  }

  it('keeps legacy parsing compatible while requiring an initial design proposal', () => {
    expect(parse({})).not.toBeNull();
    expect(parse({}, 'design', true)).toBeNull();
    expect(parse({ proposal }, 'design', true)?.proposal).toEqual(proposal);
  });

  it('requires later design support, acceptability, or a proposal', () => {
    expect(parse({}, 'design')).toBeNull();
    expect(parse({ supports: 'architect' }, 'design')).not.toBeNull();
    expect(parse({ acceptable: ['developer'] }, 'design')).not.toBeNull();
    expect(parse({ proposal }, 'design')).not.toBeNull();
  });

  it('requires a review verdict unless the member explicitly asks for a human', () => {
    expect(parse({}, 'review')).toBeNull();
    expect(parse({ verdict: 'approve' }, 'review')).not.toBeNull();
    expect(parse({ needsHuman: 'Clarify the domain contract' }, 'review')).not.toBeNull();
    expect(parse({ needsHuman: 'Clarify the scope' }, 'design', true)).not.toBeNull();
  });

  it('requires evidence for every blocking objection in every stage', () => {
    const objection = { claim: 'This breaks the contract', evidence: [], severity: 'blocking' as const };

    expect(parse({ objections: [objection] }, 'build')).toBeNull();
    expect(parse({ objections: [{ ...objection, evidence: ['src/api.ts:42'] }] }, 'build')).not.toBeNull();
  });
});

describe('round outcomes and human guidance', () => {
  it('never agrees to a nonexistent proposal', () => {
    const current = round();
    const state = { ...run(), rounds: [current] };

    expect(protocol.evaluateDesignRound(state, current)).toBe('continue');
  });

  it('resolves valid prior-round proposal references and excludes invalid acceptability', () => {
    const prior = { ...round(), closedAt: 150, id: 'round-1', number: 1, positions: { architect: position({ proposal }) } };
    const current = round();
    const state = { ...run(), rounds: [prior, current] };

    expect(protocol.evaluateDesignRound(state, current)).toBe('agreed');
    current.positions.developer = position({ acceptable: ['domain'], supports: 'domain' });
    expect(protocol.evaluateDesignRound(state, current)).toBe('continue');
  });

  it('recognizes an actual proposal supplied in the current round', () => {
    const current = round();
    current.positions.architect = position({ proposal, supports: 'architect' });

    expect(protocol.evaluateDesignRound({ ...run(), rounds: [current] }, current)).toBe('agreed');
  });

  it('does not agree when one participant has not answered', () => {
    const current = round();
    current.positions.architect = position({ acceptable: ['developer'], proposal });
    delete current.positions.developer;

    expect(protocol.evaluateDesignRound({ ...run(), rounds: [current] }, current)).toBe('continue');
  });

  it('does not retain support for an owner without an actual proposal', () => {
    const current = round();

    const normalized = protocol.normalizeSupport(run(), current, 'developer', position({ acceptable: ['architect'], supports: 'architect' }));

    expect(normalized.supports).toBeUndefined();
    expect(normalized.acceptable).toEqual([]);
  });

  it('accepts a current-round peer proposal when normalizing references', () => {
    const current = round();
    current.positions.architect = position({ proposal });

    const normalized = protocol.normalizeSupport(run(), current, 'developer', position({
      acceptable: ['architect', 'domain'],
      evidence: ['src/api.ts:42'],
      supports: 'architect',
    }));

    expect(normalized.supports).toBe('architect');
    expect(normalized.acceptable).toEqual(['architect']);
  });

  it.each(['build', 'review'] as const)('escalates needsHuman during %s', (kind) => {
    const current = round(kind);
    current.positions.architect = position({ needsHuman: 'Clarify whether compatibility may break', verdict: 'approve' });
    current.positions.developer = position({ verdict: 'approve' });

    const outcome = kind === 'build' ? protocol.evaluateBuildRound(current) : protocol.evaluateReviewRound(current);
    const decision = humanDecision(run(), current);

    expect(outcome).toBe('escalated');
    expect(decision.kind).toBe('member-failed');
    expect(decision.retryStep).toBe(kind);
    expect(decision.options.map((option) => option.id)).toEqual(['retry', 'stop']);
    expect(decision.why).toContain('Clarify whether compatibility may break');
    expect(`${decision.title} ${decision.why}`).toMatch(/guidance/i);
  });

  it('evaluates successful and failed build rounds', () => {
    const current = round('build');

    expect(protocol.evaluateBuildRound(current)).toBe('done');
    current.failures.developer = 'Pane closed';
    expect(protocol.evaluateBuildRound(current)).toBe('failed');
  });

  it.each(['design', 'build', 'review'] as const)('documents the %s contract and human guidance', (kind) => {
    const state = run();
    const current = { ...round(kind), number: 1 };
    state.rounds = [current];
    const member = { agent: 'claude' as const, label: 'Architect', paneId: 'pane', readOnly: true, role: 'architect' as const, worktreePath: '/worktree' };

    const prompt = buildRoundFile(state, current, member);

    expect(prompt).toMatch(/human guidance/i);
    expect(prompt).toContain('needsHuman');
    if (kind === 'design') expect(prompt).toMatch(/proposal.*required|required.*proposal/i);
    if (kind === 'review') expect(prompt).toMatch(/verdict.*required|required.*verdict/i);
  });
});

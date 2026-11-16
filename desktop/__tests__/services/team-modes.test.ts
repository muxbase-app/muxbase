import { describe, expect, it } from 'vitest';
import { fixLimitDecision, fixLimitReason } from '../../src/main/services/team/teamDecisions.js';
import { resolveTeamRequest } from '../../src/main/services/team/teamModes.js';
import { reduceTeamEvent } from '../../src/main/services/team/teamProtocol.js';
import { DEFAULT_TEAM_SETTINGS } from '../../src/shared/team-settings.js';

describe('Team mode defaults', () => {
  it.each([
    ['pair', 'the Writer'],
    ['duel', 'Writer A'],
    ['council', 'the Developer'],
  ] as const)('uses the %s writer name in the fix-limit action', (mode, writer) => {
    const run = reduceTeamEvent(null, { seed: {
      baseSha: 'base', brief: 'Build it', createdAt: 1, id: 'run', mode, policy: 'when-stuck', projectRoot: '/project', title: 'Build',
    }, type: 'created' }, 1);

    expect(fixLimitDecision(run, 'Checks failed.').options.find((option) => option.id === 'fix')?.title).toBe(`Give ${writer} more attempts`);
  });

  it('names the human-selected Duel writer when extending its fix attempts', () => {
    const run = reduceTeamEvent(null, { seed: {
      baseSha: 'base', brief: 'Build it', createdAt: 1, id: 'run', mode: 'duel', policy: 'when-stuck', projectRoot: '/project', title: 'Build',
    }, type: 'created' }, 1);
    run.members = [{ agent: 'claude', label: 'Candidate B', paneId: 'writer-b', readOnly: false, role: 'architect', worktreePath: '/project/b' }];
    run.selectedSourceId = 'writer-b';

    expect(fixLimitDecision(run, 'Checks failed.').options.find((option) => option.id === 'fix')?.title).toBe('Give Writer B more attempts');
  });

  it.each([
    [1, '1 fix after the initial build was not enough.'],
    [2, '2 fixes after the initial build were not enough.'],
  ] as const)('uses grammatical fix-limit copy for %s attempts', (attempts, text) => {
    expect(fixLimitReason('Checks failed.', attempts)).toBe(`Checks failed. ${text}`);
  });

  it('starts Pair with the configured writer and an independent reviewer', () => {
    const request = resolveTeamRequest({ brief: 'Build it' }, DEFAULT_TEAM_SETTINGS);
    expect(request).toMatchObject({
      maxFixRounds: 2,
      members: [{ agent: 'codex', role: 'developer' }, { agent: 'claude', role: 'tester' }],
      mode: 'pair',
      policy: 'when-stuck',
    });
  });

  it('uses authoritative limits and request overrides without mutating defaults', () => {
    const defaults = { ...DEFAULT_TEAM_SETTINGS, teamMaxFixRounds: 4, teamTimeLimitMinutes: 7, teamTokenBudget: 1234 };
    expect(resolveTeamRequest({ brief: 'Build it' }, defaults).limits).toEqual({ maxDurationMs: 420_000, maxTokens: 1234 });
    expect(resolveTeamRequest({ brief: 'Build it', maxFixRounds: 1, policy: 'every-gate' }, defaults)).toMatchObject({ maxFixRounds: 1, policy: 'every-gate' });
    expect(defaults.teamMaxFixRounds).toBe(4);
  });

  it('uses an available independent provider instead of same-provider Pair', () => {
    const defaults = { ...DEFAULT_TEAM_SETTINGS, teamReviewerAgent: 'codex' as const };
    expect(resolveTeamRequest({ brief: 'Build it' }, defaults, ['codex', 'claude']).members[1].agent).toBe('claude');
    expect(() => resolveTeamRequest({ brief: 'Build it' }, defaults, ['codex'])).toThrow(/independent/i);
  });

  it('retains Council for archived runs without a mode', () => {
    const run = reduceTeamEvent(null, { seed: {
      baseSha: 'base', brief: 'Build it', createdAt: 1, id: 'run', policy: 'when-stuck', projectRoot: '/project', title: 'Build',
    }, type: 'created' }, 1);
    expect(run.mode).toBe('council');
    expect(run.maxFixRounds).toBe(2);
  });

  it('opts into Council and keeps its configured debate roles', () => {
    const request = resolveTeamRequest({ brief: 'Build it', mode: 'council' }, DEFAULT_TEAM_SETTINGS);
    expect(request.members.map((member) => member.role)).toEqual(['developer', 'architect', 'tester']);
  });

  it('rejects out-of-range fix rounds and identical Duel sides', () => {
    expect(() => resolveTeamRequest({ brief: 'Build it', maxFixRounds: 6 }, DEFAULT_TEAM_SETTINGS)).toThrow(/fix/i);
    expect(() => resolveTeamRequest({ brief: 'Build it', mode: 'duel', duelSides: [{ agent: 'codex' }, { agent: 'codex' }] }, DEFAULT_TEAM_SETTINGS)).toThrow(/differ/i);
  });

  it('accepts distinct model or effort Duel writers from one agent with an independent comparator', () => {
    const request = resolveTeamRequest({
      brief: 'Build it', duelSides: [{ agent: 'codex', model: 'model-a' }, { agent: 'codex', model: 'model-b' }], mode: 'duel',
    }, DEFAULT_TEAM_SETTINGS, ['codex', 'claude']);
    expect(request.members).toEqual([{ agent: 'codex', model: 'model-a', role: 'developer' }, { agent: 'codex', model: 'model-b', role: 'architect' }, { agent: 'claude', role: 'tester' }]);
  });

  it('reports an unavailable selected reviewer instead of silently changing settings', () => {
    expect(() => resolveTeamRequest({ brief: 'Build it' }, DEFAULT_TEAM_SETTINGS, ['codex', 'opencode'])).toThrow(/selected reviewer claude is unavailable/);
  });

  it('allows Claude and Codex Duel writers with a physically separate Claude comparator', () => {
    const request = resolveTeamRequest({
      brief: 'Build it', duelSides: [{ agent: 'claude' }, { agent: 'codex' }],
      members: [{ agent: 'claude', role: 'developer' }, { agent: 'codex', role: 'architect' }, { agent: 'claude', role: 'tester' }],
      mode: 'duel',
    }, DEFAULT_TEAM_SETTINGS, ['claude', 'codex']);
    expect(request.members).toEqual([{ agent: 'claude', role: 'developer' }, { agent: 'codex', role: 'architect' }, { agent: 'claude', role: 'tester' }]);
  });

  it('makes default Duel usable with only Claude and Codex installed', () => {
    const request = resolveTeamRequest({ brief: 'Build it', mode: 'duel' }, DEFAULT_TEAM_SETTINGS, ['claude', 'codex']);
    expect(request.members).toEqual([{ agent: 'codex', role: 'developer' }, { agent: 'claude', role: 'architect' }, { agent: 'claude', role: 'tester' }]);
  });

  it('restores missing legacy member tuning from the saved native Duel side', () => {
    const run = reduceTeamEvent(null, { seed: {
      baseSha: 'base', brief: 'Build it', createdAt: 1,
      duelSides: [{ agent: 'claude', effort: 'high', model: 'opus' }, { agent: 'codex', effort: 'low', model: 'writer-model' }],
      id: 'run', mode: 'duel', policy: 'when-stuck', projectRoot: '/project', title: 'Build',
    }, type: 'created' }, 1);
    const restored = reduceTeamEvent(run, { member: {
      agent: 'codex', label: 'Candidate B', paneId: 'writer-b', readOnly: false, role: 'architect', worktreePath: '/project/writer-b',
    }, type: 'member' }, 2);
    expect(restored.members[0]).toMatchObject({ effort: 'low', model: 'writer-model', readOnly: false });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTeamHandlers } from '../../src/main/ipc/team.handlers.js';
import { validateIpcInvokeArgs } from '../../src/main/ipc/ipc-request-validation.js';
import { IPC } from '../../src/shared/ipc-channels.js';
import type { TeamStartRequest } from '../../src/shared/team-types.js';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}));

const request: TeamStartRequest = {
  brief: 'Fix the critical regression',
  members: [{ agent: 'claude', role: 'architect' }, { agent: 'codex', role: 'developer' }],
  policy: 'when-stuck',
};

describe('team IPC boundaries', () => {
  beforeEach(() => handlers.clear());

  it('runs every team mutation through the project coordinator', async () => {
    const calls: string[] = [];
    const bridge: Parameters<typeof registerTeamHandlers>[0] = {
      addTeamNote: () => ({ success: true }),
      decideTeamRun: async () => ({ success: true }),
      finishTeamRun: async () => ({ success: true }),
      listTeamRuns: () => [],
      prepareTeamMerge: async () => ({ success: true }),
      async runProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
        calls.push('project');
        return operation();
      },
      startTeamRun: async () => ({ success: true }),
    };
    registerTeamHandlers(bridge);

    for (const channel of [
      IPC.TEAM_START, IPC.TEAM_DECIDE, IPC.TEAM_NOTE, IPC.TEAM_PREPARE_MERGE, IPC.TEAM_FINISH,
    ]) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler ${channel}`);
      expect(await handler(undefined, { ...request, runId: 'run' })).toEqual({ success: true });
    }

    expect(calls).toHaveLength(5);
  });

  it('accepts finite run limits and rejects unbounded or invalid limits', () => {
    const limits = { maxDurationMs: 60_000, maxTokens: 100_000 };

    expect(validateIpcInvokeArgs(IPC.TEAM_START, [{ ...request, limits }])).toEqual([{ ...request, limits }]);
    for (const invalid of [
      { ...limits, maxTokens: Infinity },
      { ...limits, maxTokens: 0 },
      { ...limits, maxDurationMs: -1 },
      { ...limits, maxDurationMs: NaN },
    ]) {
      expect(() => validateIpcInvokeArgs(IPC.TEAM_START, [{ ...request, limits: invalid }])).toThrow();
    }
  });

  it('accepts settings-driven launches and mode-specific overrides', () => {
    const minimal = { brief: 'Build the requested change' };
    const duel = {
      ...minimal,
      duelSides: [{ agent: 'codex' }, { agent: 'claude' }],
      maxFixRounds: 2,
      mode: 'duel',
    };

    expect(validateIpcInvokeArgs(IPC.TEAM_START, [minimal])).toEqual([minimal]);
    expect(validateIpcInvokeArgs(IPC.TEAM_START, [duel])).toEqual([duel]);
    for (const invalid of [
      { ...minimal, mode: 'swarm' },
      { ...minimal, maxFixRounds: 0 },
      { ...minimal, maxFixRounds: 6 },
      { ...duel, duelSides: [{ agent: 'codex' }, { agent: 'codex' }] },
    ]) {
      expect(() => validateIpcInvokeArgs(IPC.TEAM_START, [invalid])).toThrow();
    }
  });

  it('validates explicit absolute run-limit extensions', () => {
    const decision = {
      decisionId: 'limit',
      extension: { maxDurationMs: 7_200_000, maxTokens: 2_000_000 },
      optionId: 'extend',
      runId: 'run',
    };

    expect(validateIpcInvokeArgs(IPC.TEAM_DECIDE, [decision])).toEqual([decision]);
    expect(() => validateIpcInvokeArgs(IPC.TEAM_DECIDE, [{
      ...decision,
      extension: { ...decision.extension, maxTokens: Infinity },
    }])).toThrow();
  });

  it('validates every Team preference through the settings IPC boundary', () => {
    const preferences = [
      { key: 'teamDefaultMode', value: 'pair' },
      { key: 'teamWriterAgent', value: 'codex' },
      { key: 'teamReviewerAgent', value: 'claude' },
      { key: 'teamPolicy', value: 'when-stuck' },
      { key: 'teamMaxFixRounds', value: 2 },
      { key: 'teamTokenBudget', value: 1_000_000 },
      { key: 'teamTimeLimitMinutes', value: 60 },
      { key: 'teamCouncilRoles', value: ['architect', 'tester'] },
    ];

    for (const preference of preferences) {
      expect(validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [preference])).toEqual([preference]);
    }
    for (const preference of [
      { key: 'teamReviewerAgent', value: 'pi' },
      { key: 'teamMaxFixRounds', value: 6 },
      { key: 'teamCouncilRoles', value: ['developer'] },
      { key: 'teamCouncilRoles', value: ['tester', 'tester'] },
      { key: 'teamTokenBudget', value: 0 },
      { key: 'teamTimeLimitMinutes', value: Infinity },
    ]) {
      expect(() => validateIpcInvokeArgs(IPC.ELECTRON_SETTINGS_UPDATE, [preference])).toThrow();
    }
  });
});

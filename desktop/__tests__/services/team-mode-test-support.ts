import { getProjectMetadataDir, type AgentName, type DuelMetadata, type MuxBasePane } from 'muxbase/core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { DuelWorkflow } from '../../src/main/services/bridge/DuelWorkflow.js';
import { TeamWorkflow } from '../../src/main/services/bridge/TeamWorkflow.js';
import type { TeamExecution } from '../../src/main/services/team/TeamExecution.js';
import type { TeamLedger } from '../../src/main/services/team/TeamLedger.js';
import { openRound } from '../../src/main/services/team/teamProtocol.js';
import type { TeamLaunchOptions, TeamWorkflowDependencies } from '../../src/main/services/team/teamWorkflowTypes.js';
import { createEmptySession, type NormalizedSession } from '../../src/shared/agent-session-types.js';
import type { PaneActivity } from '../../src/shared/pane-activity.js';
import { DEFAULT_TEAM_SETTINGS } from '../../src/shared/team-settings.js';
import type { TeamPosition, TeamRoleId, TeamStartRequest } from '../../src/shared/team-types.js';

const roots: string[] = [];
export const ready: PaneActivity = {
  activityRevision: 1, adapterHealth: 'healthy', certainty: 'confirmed', liveness: 'running',
  openBackgroundWork: [], origin: 'adapter', paneIncarnationId: 'live', sinceWallMs: 1, state: 'idle',
};
const position: TeamPosition = { acceptable: [], evidence: ['git diff --check passed'], objections: [], responses: [], summary: 'Done', verdict: 'approve' };

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function cleanupTeamModeFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export async function fixture(request: Partial<TeamStartRequest> = {}, initialFailureRole?: TeamRoleId, initialTuning = { effort: '', model: '' }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'team-mode-tests-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Team test']);
  git(root, ['config', 'user.email', 'team@example.test']);
  writeFileSync(join(root, 'code.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const panes = new Map<string, MuxBasePane>();
  const sessions = new Map<string, NormalizedSession>();
  const activities = new Map<string, PaneActivity>();
  const launches: Array<{ options: TeamLaunchOptions; pane: MuxBasePane }> = [];
  const creationAttempts: string[] = [];
  const interrupts: string[] = [];
  const resumes: string[] = [];
  let usage = 0;
  let tuning = initialTuning;
  let failRole = initialFailureRole;
  const launch = async (prompt: string, agent: AgentName, options: TeamLaunchOptions & { duel?: DuelMetadata }) => {
    const role = options.slugBase.split('-')[1] as TeamRoleId;
    creationAttempts.push(role);
    if (role === failRole) return { error: 'injected launch failure', success: false };
    const slug = `${options.slugBase}${options.duel ? `-${options.duel.role}` : ''}`;
    const worktree = join(getProjectMetadataDir(root), 'worktrees', slug);
    mkdirSync(resolve(worktree, '..'), { recursive: true });
    git(root, ['worktree', 'add', '-q', '-b', slug, worktree, options.worktreeStartPoint ?? 'HEAD']);
    const seed = join(worktree, options.worktreeSeedFile.relativePath);
    mkdirSync(resolve(seed, '..'), { recursive: true });
    writeFileSync(seed, options.worktreeSeedFile.content);
    const pane: MuxBasePane = {
      agent, duel: options.duel, id: role, paneId: `%${panes.size}`, projectRoot: root,
      prompt, role: options.role, slug, teamRunId: options.teamRunId, worktreePath: worktree,
    };
    panes.set(pane.id, pane);
    activities.set(pane.id, { ...ready, paneIncarnationId: role });
    const session = createEmptySession(agent, role);
    session.turnCompleted = true;
    if (!options.readOnly) {
      writeFileSync(join(worktree, 'code.txt'), `${role} implementation\n`);
      const round = /"round": "([^"]+)"/.exec(options.worktreeSeedFile.content)?.[1];
      session.messages.push({ content: `\`\`\`team-position\n${JSON.stringify({ round, summary: 'Built', evidence: ['code.txt'] })}\n\`\`\``, id: 'fast-reply', timestamp: Date.now(), toolCalls: [], toolResults: [], type: 'assistant' });
      await new Promise((complete) => setTimeout(complete, 5));
    }
    sessions.set(pane.id, session);
    launches.push({ options, pane });
    return { pane, success: true };
  };
  const native = new DuelWorkflow({
    buildActionContext: () => ({} as never),
    closePane: async () => ({ message: 'closed', type: 'success' }),
    createPane: async (prompt, agent, options) => {
      if (!options.teamRunId || !options.agentPrompt || !options.paneTitle || !options.projectRoot || !options.worktreeSeedFile) throw new Error('Missing native Team options');
      return launch(prompt, agent, { ...options, agentPrompt: options.agentPrompt, paneTitle: options.paneTitle, projectRoot: options.projectRoot, readOnly: false, teamRunId: options.teamRunId, useWorktree: true, worktreeSeedFile: options.worktreeSeedFile });
    },
    getPane: (id) => panes.get(id), getPanes: () => [...panes.values()], getProjectRoot: () => root,
    hasActiveProjectContext: () => true, reapOrphanedTranscripts: async () => {},
    replacePanesBestEffort: (values) => { for (const pane of values) panes.set(pane.id, pane); },
    setProgress: () => {},
  });
  const dependencies: TeamWorkflowDependencies = {
    clearStartupPrompt: async () => {},
    closePane: async (pane) => { panes.delete(pane.id); return null; },
    createDuelCandidate: (prompt, side, options) => native.createTeamCandidate(prompt, side, options),
    createPane: launch,
    emitRun: () => {},
    getAvailableAgents: () => ['codex', 'claude', 'opencode'],
    getDefaults: () => DEFAULT_TEAM_SETTINGS,
    getEffectiveLaunchTuning: () => tuning,
    getPane: (id) => panes.get(id),
    getPanes: () => [...panes.values()],
    getPaneActivity: (id) => activities.get(id),
    getPaneUsage: () => usage,
    getProjectRoot: () => root,
    getSession: (id) => sessions.get(id) ?? null,
    hasActiveProjectContext: () => true,
    interruptPane: async (id) => {
      interrupts.push(id);
      const activity = activities.get(id);
      if (activity) activities.set(id, { ...activity, liveness: 'stopped', state: 'stopped' });
    },
    notify: () => {},
    resumePane: async (id) => {
      resumes.push(id);
      if (!panes.has(id)) return { error: 'Cannot locate preserved pane', success: false };
      activities.set(id, { ...ready, paneIncarnationId: `resumed-${id}-${resumes.length}` });
      return { success: true };
    },
    runProjectMutation: async (action) => action(),
    sendPromptToPane: async () => {},
  };
  const workflow = new TeamWorkflow(dependencies);
  const internal = workflow as unknown as { execution: TeamExecution; ledger: TeamLedger; step(id: string): Promise<void>; tick(): void; limits: { drain(): Promise<void> } };
  const started = await workflow.startRun({ brief: 'Implement it', checkCommand: 'git diff --check', ...request });
  expect(started.success).toBe(true);
  const runId = started.run?.id ?? '';
  await internal.execution.drain(runId);
  const ledger = internal.ledger;
  const step = () => internal.execution.track(runId, () => internal.execution.mutation(ledger.get(runId), () => internal.step(runId)));
  const answer = async () => {
    const round = openRound(ledger.get(runId));
    if (!round) throw new Error('No open round');
    for (const role of round.participants) ledger.commit(runId, { position, role, roundId: round.id, type: 'position' });
    await step();
  };
  return {
    activities, answer, creationAttempts, dependencies, internal, interrupts, launches, ledger, native, panes, resumes, root, runId, step, workflow,
    setEffectiveTuning: (value: typeof initialTuning) => { tuning = value; },
    setFailRole: (role?: TeamRoleId) => { failRole = role; },
    setUsage: (value: number) => { usage = value; },
  };
}

import type { AgentName, DuelMetadata, MuxBasePane } from 'muxbase/core';
import type { DuelSideConfig, PaneCreateResponse } from '../../../shared/ipc-types.js';
import type { TeamSettingsDefaults } from '../../../shared/team-settings.js';
import type { TeamRun } from '../../../shared/team-types.js';
import type { TeamPaneAccess } from './TeamRoundPoller.js';

export interface TeamLaunchOptions {
  agentPrompt: string;
  effort?: string;
  model?: string;
  paneTitle: string;
  projectRoot: string;
  readOnly: boolean;
  role?: 'review';
  slugBase: string;
  teamRunId: string;
  useWorktree: true;
  worktreeSeedFile: { content: string; relativePath: string };
  worktreeStartPoint?: string;
}

interface TeamEffectiveLaunchTuning {
  effort: string;
  model: string;
}

export interface TeamDuelLaunchOptions extends TeamLaunchOptions {
  duel: DuelMetadata;
}

export interface TeamDuelCandidateResponse extends PaneCreateResponse {
  recovered?: boolean;
}

export interface TeamWorkflowDependencies extends TeamPaneAccess {
  closePane(pane: MuxBasePane): Promise<string | null>;
  createPane(prompt: string, agent: AgentName, options: TeamLaunchOptions): Promise<PaneCreateResponse>;
  createDuelCandidate?(prompt: string, side: DuelSideConfig, options: TeamDuelLaunchOptions): Promise<TeamDuelCandidateResponse>;
  emitRun(run: TeamRun): void;
  getProjectRoot(): string;
  getEffectiveLaunchTuning?(agent: AgentName, projectRoot: string): TeamEffectiveLaunchTuning;
  getPanes?(): MuxBasePane[];
  getDefaults?(): TeamSettingsDefaults;
  getAvailableAgents?(): AgentName[];
  hasActiveProjectContext(): boolean;
  interruptPane(paneId: string): Promise<void>;
  getPaneUsage?(paneId: string): number;
  notify(message: string, run?: TeamRun): void;
  resumePane(paneId: string): Promise<{ success: boolean; error?: string }>;
  runProjectMutation<T>(action: () => Promise<T>): Promise<T>;
}

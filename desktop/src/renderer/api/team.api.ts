import { IPC } from '../../shared/ipc-channels';
import type {
  TeamActionResponse,
  TeamDecideRequest,
  TeamFinishRequest,
  TeamNoteRequest,
  TeamPrepareMergeResponse,
  TeamRun,
  TeamRunRequest,
  TeamStartRequest,
  TeamStartResponse,
} from '../../shared/team-types';
import { invoke } from './ipc';

export function listTeamRuns(): Promise<TeamRun[]> {
  return invoke<TeamRun[]>(IPC.TEAM_LIST);
}

export function startTeamRun(request: TeamStartRequest): Promise<TeamStartResponse> {
  return invoke<TeamStartResponse>(IPC.TEAM_START, request);
}

export function decideTeamRun(request: TeamDecideRequest): Promise<TeamActionResponse> {
  return invoke<TeamActionResponse>(IPC.TEAM_DECIDE, request);
}

export function addTeamNote(request: TeamNoteRequest): Promise<TeamActionResponse> {
  return invoke<TeamActionResponse>(IPC.TEAM_NOTE, request);
}

export function prepareTeamMerge(request: TeamRunRequest): Promise<TeamPrepareMergeResponse> {
  return invoke<TeamPrepareMergeResponse>(IPC.TEAM_PREPARE_MERGE, request);
}

export function finishTeamRun(request: TeamFinishRequest): Promise<TeamActionResponse> {
  return invoke<TeamActionResponse>(IPC.TEAM_FINISH, request);
}

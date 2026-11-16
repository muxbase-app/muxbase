import { IPC } from '../../shared/ipc-channels.js';
import type {
  TeamDecideRequest,
  TeamFinishRequest,
  TeamNoteRequest,
  TeamRunRequest,
  TeamStartRequest,
} from '../../shared/team-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

async function guarded<T>(channel: string, action: () => Promise<T> | T): Promise<T | { error: string; success: false }> {
  try {
    return await action();
  } catch (error) {
    log.error('ipc:team', `${channel} failed`, error);
    return { error: formatError(error), success: false };
  }
}

type TeamHandlerBridge = Pick<MuxBaseBridge,
  'addTeamNote' | 'decideTeamRun' | 'finishTeamRun' | 'listTeamRuns' |
  'prepareTeamMerge' | 'runProjectMutation' | 'startTeamRun'
>;

export function registerTeamHandlers(bridge: TeamHandlerBridge): void {
  secureHandle(IPC.TEAM_LIST, async () => bridge.listTeamRuns());
  secureHandle(IPC.TEAM_START, async (_event, request: TeamStartRequest) => (
    guarded(IPC.TEAM_START, () => bridge.runProjectMutation(() => bridge.startTeamRun(request)))
  ));
  secureHandle(IPC.TEAM_DECIDE, async (_event, request: TeamDecideRequest) => (
    guarded(IPC.TEAM_DECIDE, () => bridge.runProjectMutation(() => bridge.decideTeamRun(request)))
  ));
  secureHandle(IPC.TEAM_NOTE, async (_event, request: TeamNoteRequest) => (
    guarded(IPC.TEAM_NOTE, () => bridge.runProjectMutation(async () => bridge.addTeamNote(request)))
  ));
  secureHandle(IPC.TEAM_PREPARE_MERGE, async (_event, request: TeamRunRequest) => (
    guarded(IPC.TEAM_PREPARE_MERGE, () => bridge.runProjectMutation(() => bridge.prepareTeamMerge(request.runId)))
  ));
  secureHandle(IPC.TEAM_FINISH, async (_event, request: TeamFinishRequest) => (
    guarded(IPC.TEAM_FINISH, () => bridge.runProjectMutation(() => bridge.finishTeamRun(request)))
  ));
}

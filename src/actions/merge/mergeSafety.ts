import type { MuxBasePane } from '../../types.js';
import type { ActionContext } from '../types.js';
import { execFileAsync } from '../../utils/execAsync.js';
import { mergeWorktreeIntoMain, type CertifiedMergePublication, type MergeResult } from '../../utils/gitMergeOps.js';
import { triggerHook, triggerHookWithResult } from '../../utils/hooks.js';

export async function runMergeHook(
  pane: MuxBasePane,
  context: ActionContext,
  targetPath: string,
  teamMerge: boolean,
  extraData: Record<string, string>,
): Promise<string | undefined> {
  if (!teamMerge) {
    await triggerHook('post_merge', targetPath, pane, extraData);
    return;
  }
  if (!context.onTeamMergeHookStart || !context.onTeamMergeHookComplete) {
    return 'Git merged the reviewed source, but the post-merge hook was not launched: durable hook callbacks are missing.';
  }
  try {
    const operationId = context.onTeamMergeHookStart(pane);
    const result = await triggerHookWithResult('post_merge', targetPath, pane, { ...extraData, MUXBASE_TEAM_MERGE_ID: operationId });
    const error = result.success ? undefined : `Git merged the reviewed source, but the post-merge hook failed: ${result.error}`;
    context.onTeamMergeHookComplete(pane, error);
    return error;
  } catch (failure) {
    return `Git merged the reviewed source, but its post-merge hook execution or outcome recording needs attention: ${failure instanceof Error ? failure.message : String(failure)}. Do not repeat external effects without checking them.`;
  }
}

export async function mergeCertifiedTarget(
  pane: MuxBasePane,
  context: ActionContext,
  targetPath: string,
  worktreePath: string,
  revision: string,
): Promise<MergeResult> {
  const teamMerge = isTeamOwnedWriter(pane, context);
  if (teamMerge && (!context.prepareTeamMerge || !context.onTeamMergeSuccess)) {
    return { success: false, error: 'Team merges require durable publication and completion callbacks.' };
  }
  let publication: CertifiedMergePublication | undefined;
  try {
    publication = teamMerge ? await context.prepareTeamMerge?.(pane, targetPath, revision) : undefined;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  const validate = () => getMergeSafetyError(pane, context, worktreePath, revision);
  const merged = publication
    ? await mergeWorktreeIntoMain(targetPath, revision, validate, publication)
    : await mergeWorktreeIntoMain(targetPath, revision, validate);
  if (!teamMerge) return merged;
  let error: string | null | undefined;
  try {
    error = await context.onTeamMergeSuccess?.(pane);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  if (!merged.success) return error ? merged : {
    success: false, published: true, teamMerge,
    error: `The durable receipt confirms publication, but Git reported: ${merged.error}`,
  };
  return error
    ? { success: false, published: true, teamMerge, error: `Git published the reviewed source, but Team finalization needs attention: ${error}` }
    : { success: true, published: true, teamMerge };
}

export function isTeamOwnedWriter(pane: MuxBasePane, context: ActionContext): boolean {
  return context.isTeamOwnedWriter ? context.isTeamOwnedWriter(pane) : Boolean(pane.teamRunId);
}

export async function getMergeSafetyError(
  pane: MuxBasePane,
  context: ActionContext,
  worktreePath: string | undefined = pane.worktreePath,
  sourceRevision?: string,
): Promise<string | null> {
  if (pane.teamRunId && !context.validateMerge) {
    return 'Team Room approval must be validated before merging this pane';
  }
  return context.validateMerge ? context.validateMerge(pane, worktreePath, sourceRevision) : null;
}

export async function getValidatedMergeSource(
  pane: MuxBasePane,
  context: ActionContext,
  worktreePath: string,
  branch: string,
): Promise<{ success: true; revision: string } | { success: false; error: string }> {
  let revision = branch;
  if (isTeamOwnedWriter(pane, context)) {
    try {
      revision = (await execFileAsync('git', ['rev-parse', '--verify', `${branch}^{commit}`], {
        cwd: worktreePath,
      })).trim();
    } catch (error) {
      return { success: false, error: `Unable to resolve Team merge source: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const error = await getMergeSafetyError(pane, context, worktreePath, revision);
  return error ? { success: false, error } : { success: true, revision };
}

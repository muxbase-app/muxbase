import { getPaneBranchName, type MuxBasePane } from 'muxbase/core';
import { gitOrThrow } from '../git/gitDiff.js';

export async function verifyTeamMergeSource(pane: MuxBasePane, worktreePath: string, approvedSnapshot: string, sourceRevision?: string): Promise<void> {
  const branch = getPaneBranchName(pane);
  const [symbolic, branchHead, head] = await Promise.all([
    gitOrThrow(worktreePath, ['symbolic-ref', '--short', 'HEAD']),
    gitOrThrow(worktreePath, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]),
    gitOrThrow(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  if (symbolic.trim() !== branch || branchHead.trim() !== head.trim()) throw new Error('The Team source branch does not own the registered worktree HEAD');
  if (sourceRevision === undefined) return;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceRevision) || sourceRevision !== head.trim()) throw new Error('The pinned Team source revision does not match its owned branch HEAD');
  const trees = await Promise.all([sourceRevision, approvedSnapshot].map((sha) => gitOrThrow(worktreePath, ['rev-parse', `${sha}^{tree}`])));
  if (trees[0].trim() !== trees[1].trim()) throw new Error('The pinned Team source revision is not the certified snapshot tree');
}

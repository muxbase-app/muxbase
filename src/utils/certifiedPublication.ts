import { existsSync } from 'node:fs';
import { execFileAsync } from './execAsync.js';
import { prepareHeadUpdate } from './gitRefTransaction.js';
import {
  type CertifiedMergePublication, TeamPublicationJournal, type TeamPublicationRecord,
  validatePublication,
} from './teamPublicationJournal.js';

const GIT_WRITE_TIMEOUT_MS = 5 * 60_000;

export async function assertTeamPublicationSupport(root: string): Promise<void> {
  const version = (await execFileAsync('git', ['--version'], { cwd: root })).trim();
  const match = /^git version (\d+)\.(\d+)(?:\.|$)/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 29)) {
    throw new Error(`Team Room requires Git 2.29 or newer for locked publication transactions. Found: ${version}`);
  }
}

async function assertTarget(root: string, publication: CertifiedMergePublication): Promise<void> {
  const ref = (await execFileAsync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root })).trim();
  if (ref !== publication.targetRef) throw new Error('The certified merge target changed; approval must be revalidated.');
}

export async function hasCertifiedPublicationReceipt(
  root: string, record: CertifiedMergePublication, sourceSha: string,
): Promise<boolean> {
  const output = await execFileAsync('git', ['reflog', 'show', '--format=%H%x00%gs', record.targetRef], { cwd: root });
  const entries = output.trim().split('\n');
  return entries.some((entry, index) => entry.startsWith(`${sourceSha}\0muxbase-team-merge:${record.operationId}:`)
    && entries[index + 1]?.startsWith(`${record.targetSha}\0`));
}

function assertSameOperation(record: TeamPublicationRecord, publication: CertifiedMergePublication, sourceSha: string): void {
  if (record.operationId !== publication.operationId || record.targetRef !== publication.targetRef
    || record.targetSha !== publication.targetSha || record.sourceSha !== sourceSha) {
    throw new Error('An unfinished Team publication owns this worktree. Recover that operation before another merge.');
  }
}

export async function recoverCertifiedPublication(
  root: string, publication: CertifiedMergePublication, sourceSha: string,
): Promise<boolean> {
  validatePublication(publication, sourceSha);
  const journal = await TeamPublicationJournal.at(root, publication.operationId);
  const record = journal.read();
  if (!record) return false;
  assertSameOperation(record, publication, sourceSha);
  if (!record.checkoutStarted) {
    journal.assertOwned(record);
    const transaction = await prepareHeadUpdate(root, publication.targetSha, publication.targetSha, 'muxbase-team-recovery: inspect');
    try { await assertTarget(root, publication); } finally { await transaction.abort(); }
    journal.cleanup(record);
    return false;
  }
  if (!record.checkoutCompleted) {
    throw new Error(`Team publication was interrupted during checkout. Its files and owned index lock are preserved; inspect the worktree before manual recovery. Journal: ${journal.path}`);
  }
  if (!existsSync(journal.lockPath)) {
    if (!record.indexInstalled || !await hasCertifiedPublicationReceipt(root, record, sourceSha)) {
      throw new Error(`Team publication lost its index ownership. Preserve the journal and worktree: ${journal.path}`);
    }
    journal.cleanup(record);
    return true;
  }
  journal.assertOwned(record);
  const current = (await execFileAsync('git', ['rev-parse', record.targetRef], { cwd: root })).trim();
  const alreadyPublished = current === sourceSha && await hasCertifiedPublicationReceipt(root, record, sourceSha);
  if (current !== record.targetSha && !alreadyPublished) {
    throw new Error(`The interrupted Team publication target moved externally. No changes were rolled back; inspect ${journal.path}`);
  }
  const transaction = await prepareHeadUpdate(root, sourceSha, current, `muxbase-team-merge:${record.operationId}: publish`);
  try {
    await assertTarget(root, record);
    const installed = journal.install(record);
    if (!alreadyPublished) await transaction.commit();
    await transaction.abort();
    journal.cleanup(installed);
    return true;
  } finally {
    await transaction.abort();
  }
}

export async function publishCertifiedMerge(
  root: string, source: string, publication: CertifiedMergePublication,
): Promise<void> {
  const sourceSha = (await execFileAsync('git', ['rev-parse', '--verify', `${source}^{commit}`], { cwd: root })).trim();
  validatePublication(publication, sourceSha);
  if (sourceSha === publication.targetSha) throw new Error('There is no reviewed change to publish.');
  if (await recoverCertifiedPublication(root, publication, sourceSha)) return;
  const journal = await TeamPublicationJournal.at(root, publication.operationId);
  let record = journal.acquire(publication, sourceSha);
  let transaction: Awaited<ReturnType<typeof prepareHeadUpdate>> | undefined;
  try {
    transaction = await prepareHeadUpdate(root, sourceSha, publication.targetSha, `muxbase-team-merge:${publication.operationId}: publish`);
    await assertTarget(root, publication);
    await execFileAsync('git', ['merge-base', '--is-ancestor', publication.targetSha, sourceSha], { cwd: root });
    const options = { cwd: root, env: { ...process.env, GIT_INDEX_FILE: journal.stagePath }, timeout: GIT_WRITE_TIMEOUT_MS };
    await execFileAsync('git', ['read-tree', '--dry-run', '-m', '-u', publication.targetSha, sourceSha], options);
    record = { ...record, checkoutStarted: true };
    journal.write(record);
    await execFileAsync('git', ['read-tree', '-m', '-u', publication.targetSha, sourceSha], options);
    record = journal.seal(record);
    record = journal.install(record);
    await transaction.commit();
    journal.cleanup(record);
  } catch (error) {
    await transaction?.abort();
    if (!record.checkoutStarted) journal.cleanup(record);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(record.checkoutStarted
      ? `${message}. Team publication requires recovery; worktree and index ownership are preserved in ${journal.path}`
      : message, { cause: error });
  } finally {
    await transaction?.abort();
  }
}

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileAsync } from './execAsync.js';

export interface CertifiedMergePublication {
  operationId: string;
  targetRef: string;
  targetSha: string;
}

export interface TeamPublicationRecord extends CertifiedMergePublication {
  checkoutCompleted: boolean;
  checkoutStarted: boolean;
  indexInstalled: boolean;
  lockDevice: string;
  lockInode: string;
  originalIndexHash: string;
  sourceSha: string;
  stagedIndexHash?: string;
  version: 1;
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableFile(path: string, content: string | Buffer, mode = 0o600): void {
  const fd = openSync(path, 'wx', mode);
  try {
    writeFileSync(fd, content);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function objectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

export function validatePublication(publication: CertifiedMergePublication, sourceSha: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(publication.operationId) || !objectId(sourceSha)
    || !objectId(publication.targetSha) || !/^refs\/heads\/[^\s\0]+$/.test(publication.targetRef)) {
    throw new Error('The certified Git publication identity is invalid.');
  }
}

export class TeamPublicationJournal {
  readonly path: string;
  readonly lockPath: string;
  readonly stagePath: string;

  private constructor(readonly indexPath: string, readonly directory: string, operationId: string) {
    this.path = join(directory, 'muxbase-team-publication.json');
    this.lockPath = `${indexPath}.lock`;
    this.stagePath = join(directory, `muxbase-team-${operationId}.index`);
  }

  static async at(root: string, operationId: string): Promise<TeamPublicationJournal> {
    const index = await execFileAsync('git', ['rev-parse', '--git-path', 'index'], { cwd: root });
    const directory = await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: root });
    return new TeamPublicationJournal(resolve(root, index.trim()), resolve(root, directory.trim()), operationId);
  }

  read(): TeamPublicationRecord | undefined {
    if (!existsSync(this.path)) return undefined;
    const record: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!record || typeof record !== 'object' || !('version' in record) || record.version !== 1
      || !('operationId' in record) || typeof record.operationId !== 'string'
      || !('targetRef' in record) || typeof record.targetRef !== 'string'
      || !('targetSha' in record) || !objectId(record.targetSha)
      || !('sourceSha' in record) || !objectId(record.sourceSha)) {
      throw new Error(`The Team publication journal is invalid. Preserve it for recovery: ${this.path}`);
    }
    return this.readState(record, {
      operationId: record.operationId, sourceSha: record.sourceSha,
      targetRef: record.targetRef, targetSha: record.targetSha,
    });
  }

  private readState(record: object, identity: CertifiedMergePublication & { sourceSha: string }): TeamPublicationRecord {
    if (!('checkoutStarted' in record) || typeof record.checkoutStarted !== 'boolean'
      || !('checkoutCompleted' in record) || typeof record.checkoutCompleted !== 'boolean'
      || !('indexInstalled' in record) || typeof record.indexInstalled !== 'boolean'
      || !('originalIndexHash' in record) || typeof record.originalIndexHash !== 'string'
      || !('lockDevice' in record) || typeof record.lockDevice !== 'string'
      || !('lockInode' in record) || typeof record.lockInode !== 'string') {
      throw new Error(`The Team publication state is invalid. Preserve it for recovery: ${this.path}`);
    }
    const stagedIndexHash = 'stagedIndexHash' in record ? record.stagedIndexHash : undefined;
    if (stagedIndexHash !== undefined && typeof stagedIndexHash !== 'string') {
      throw new Error(`The Team publication index identity is invalid: ${this.path}`);
    }
    if ((record.checkoutCompleted && (!record.checkoutStarted || !stagedIndexHash))
      || (record.indexInstalled && !record.checkoutCompleted)) {
      throw new Error(`The Team publication transition is invalid. Preserve it for recovery: ${this.path}`);
    }
    validatePublication(identity, identity.sourceSha);
    return {
      ...identity, checkoutCompleted: record.checkoutCompleted, checkoutStarted: record.checkoutStarted,
      indexInstalled: record.indexInstalled, lockDevice: record.lockDevice, lockInode: record.lockInode,
      originalIndexHash: record.originalIndexHash, stagedIndexHash, version: 1,
    };
  }

  write(record: TeamPublicationRecord): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    durableFile(temporary, `${JSON.stringify(record)}\n`);
    renameSync(temporary, this.path);
    syncDirectory(this.directory);
  }

  acquire(publication: CertifiedMergePublication, sourceSha: string): TeamPublicationRecord {
    if (lstatSync(this.indexPath).isSymbolicLink()) throw new Error('Team publication requires a regular Git index.');
    const fd = openSync(this.lockPath, 'wx', 0o600);
    try {
      writeFileSync(fd, `muxbase-team-merge:${publication.operationId}\n`);
      fsyncSync(fd);
      const identity = fstatSync(fd, { bigint: true });
      const record: TeamPublicationRecord = {
        ...publication, checkoutCompleted: false, checkoutStarted: false, indexInstalled: false,
        lockDevice: identity.dev.toString(), lockInode: identity.ino.toString(),
        originalIndexHash: fileHash(this.indexPath), sourceSha, version: 1,
      };
      this.write(record);
      durableFile(this.stagePath, readFileSync(this.indexPath));
      return record;
    } finally { closeSync(fd); }
  }

  assertOwned(record: TeamPublicationRecord): void {
    const identity = lstatSync(this.lockPath, { bigint: true });
    if (!identity.isFile() || identity.dev.toString() !== record.lockDevice
      || identity.ino.toString() !== record.lockInode
      || readFileSync(this.lockPath, 'utf8') !== `muxbase-team-merge:${record.operationId}\n`) {
      throw new Error(`The Team publication index lock is no longer owned. Preserve all files: ${this.path}`);
    }
  }

  seal(record: TeamPublicationRecord): TeamPublicationRecord {
    const fd = openSync(this.stagePath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const sealed = { ...record, checkoutCompleted: true, stagedIndexHash: fileHash(this.stagePath) };
    this.write(sealed);
    return sealed;
  }

  install(record: TeamPublicationRecord): TeamPublicationRecord {
    this.assertOwned(record);
    const current = fileHash(this.indexPath);
    if (!record.stagedIndexHash || fileHash(this.stagePath) !== record.stagedIndexHash
      || (current !== record.originalIndexHash && current !== record.stagedIndexHash)) {
      throw new Error(`The Team publication index changed externally. Preserve all files: ${this.path}`);
    }
    const temporary = `${this.stagePath}.${randomUUID()}.install`;
    durableFile(temporary, readFileSync(this.stagePath), lstatSync(this.indexPath).mode & 0o777);
    renameSync(temporary, this.indexPath);
    syncDirectory(dirname(this.indexPath));
    const installed = { ...record, indexInstalled: true };
    this.write(installed);
    return installed;
  }

  cleanup(record: TeamPublicationRecord): void {
    if (existsSync(this.lockPath)) {
      this.assertOwned(record);
      unlinkSync(this.lockPath);
    }
    if (existsSync(this.stagePath)) unlinkSync(this.stagePath);
    unlinkSync(this.path);
    syncDirectory(this.directory);
  }
}

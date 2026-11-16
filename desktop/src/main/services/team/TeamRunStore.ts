import { AGENT_IDS, getProjectMetadataDir } from 'muxbase/core';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { TEAM_ROLE_IDS, type TeamEvent, type TeamRun } from '../../../shared/team-types.js';
import { log } from '../Logger.js';
import { teamPositionSchema } from './teamPositions.js';
import { reduceTeamEvent } from './teamProtocol.js';

const EVENTS_FILE = 'events.ndjson';
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_EVENTS = 1000;
const text = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const role = z.enum(TEAM_ROLE_IDS);
const roles = z.array(role).max(TEAM_ROLE_IDS.length);
const nextStep = z.enum(['build', 'check', 'design', 'recover', 'review', 'ship']);
const status = z.enum(['failed', 'merged', 'ready', 'running', 'starting', 'stopped', 'stopping', 'waiting']);
const roundOutcome = z.enum(['agreed', 'blocked', 'continue', 'done', 'escalated', 'failed']);
const memberConfig = z.object({
  agent: z.enum(AGENT_IDS),
  domain: z.string().optional(),
  effort: z.string().optional(),
  model: z.string().optional(),
  role,
});
const member = memberConfig.extend({
  label: text,
  paneId: text,
  readOnly: z.boolean(),
  worktreePath: text,
});
const duelSnapshot = z.object({
  checkedSnapshot: text.optional(),
  checksPassed: z.boolean(),
  paneId: text,
  snapshotSha: text,
});
const snapshots = z.partialRecord(role, duelSnapshot);
const limits = z.object({ maxDurationMs: count.positive(), maxTokens: count.positive() });
const limitPause = z.object({ at: timestamp, pendingDecisionId: text.optional(), quiesced: z.boolean(), reason: text, resumeStep: nextStep });
const duelSide = z.object({ agent: z.enum(AGENT_IDS), effort: text.optional(), model: text.optional() });
const round = z.object({
  baselines: z.partialRecord(role, count),
  closedAt: timestamp.optional(),
  comparison: z.boolean().optional(),
  candidateSnapshots: snapshots.optional(),
  deliveryAttempts: z.partialRecord(role, z.object({ at: timestamp, sessionId: text.optional(), state: z.enum(['pending', 'sent']) })).optional(),
  failures: z.partialRecord(role, text),
  id: text,
  kind: z.enum(['build', 'design', 'review']),
  notes: z.array(z.string()),
  number: count,
  openedAt: timestamp,
  outcome: roundOutcome.optional(),
  participants: roles.min(1).refine((value) => new Set(value).size === value.length),
  positions: z.partialRecord(role, teamPositionSchema),
  reminded: roles,
  snapshotSha: text.optional(),
  targetSha: text.optional(),
  undelivered: roles,
});
const approval = z.object({
  at: timestamp,
  checkedSnapshot: text.optional(),
  decisionId: text.optional(),
  kind: z.enum(['review', 'waiver']),
  reason: z.string().optional(),
  snapshotSha: text,
  sourcePaneId: text.optional(),
  targetSha: text,
});
const decision = z.object({
  chosen: text.optional(),
  id: text,
  kind: z.enum(['approval', 'design', 'duel-winner', 'fix-limit', 'limit', 'member-failed']),
  label: text,
  note: z.string().optional(),
  openedAt: timestamp,
  options: z.array(z.object({
    cost: z.string().optional(),
    gain: z.string().optional(),
    holders: roles,
    id: text,
    risk: z.string().optional(),
    summary: z.string().optional(),
    title: text,
  })),
  retryStep: nextStep.optional(),
  roundId: text.optional(),
  settled: z.array(z.string()),
  title: text,
  why: z.string(),
});
const feedBase = z.object({ at: timestamp, id: text, lane: z.enum(['agreed', 'contested', 'working']).optional() });
const feed = z.discriminatedUnion('kind', [
  feedBase.extend({ kind: z.literal('agreed'), text: z.string(), title: text, votes: z.string() }),
  feedBase.extend({ command: text, kind: z.literal('check'), output: z.string().optional(), passed: z.boolean() }),
  feedBase.extend({ decisionId: text, kind: z.literal('decision') }),
  feedBase.extend({ kind: z.literal('final') }),
  feedBase.extend({ kind: z.literal('human'), text: z.string() }),
  feedBase.extend({ kind: z.literal('lead'), text: z.string() }),
  feedBase.extend({
    evidence: z.array(z.string()),
    kind: z.literal('message'),
    label: text,
    reply: z.boolean(),
    role,
    text: z.string(),
  }),
  feedBase.extend({ kind: z.literal('round'), roundId: text }),
]);
const mergeHookSchema = z.object({
  at: timestamp,
  error: z.string().optional(),
  state: z.enum(['running', 'succeeded', 'failed', 'unknown']),
});

const eventSchema: z.ZodType<TeamEvent> = z.discriminatedUnion('type', [
  z.object({
    seed: z.object({
      baseSha: text,
      brief: text,
      checkCommand: z.string().optional(),
      createdAt: timestamp,
      id: text,
      duelSides: z.tuple([duelSide, duelSide]).optional(),
      limits: limits.optional(),
      maxFixRounds: count.min(1).max(5).optional(),
      mode: z.enum(['pair', 'duel', 'council']).optional(),
      plannedMembers: z.array(memberConfig).optional(),
      policy: z.enum(['every-gate', 'when-stuck']),
      projectRoot: text,
      title: text,
    }),
    type: z.literal('created'),
  }),
  z.object({ member, type: z.literal('member') }),
  z.object({ round, type: z.literal('round-opened') }),
  z.object({ baseline: count, role, roundId: text, type: z.literal('delivered') }),
  z.object({ role, roundId: text, sessionId: text.optional(), state: z.enum(['pending', 'sent']), type: z.literal('delivery-attempt') }),
  z.object({ role, roundId: text, type: z.literal('delivery-reconciled') }),
  z.object({ role, roundId: text, type: z.literal('reminded') }),
  z.object({ position: teamPositionSchema, role, roundId: text, type: z.literal('position') }),
  z.object({ reason: text, role, roundId: text, type: z.literal('member-failed') }),
  z.object({ outcome: roundOutcome, roundId: text, type: z.literal('round-closed') }),
  z.object({ item: feed, type: z.literal('feed') }),
  z.object({ next: nextStep.optional(), type: z.literal('next') }),
  z.object({ stage: z.enum(['design', 'build', 'review', 'ship']), type: z.literal('stage') }),
  z.object({ decision, type: z.literal('decision-opened') }),
  z.object({ chosen: text, decisionId: text, note: z.string().optional(), type: z.literal('decision-resolved') }),
  z.object({ text: z.string(), type: z.literal('note') }),
  z.object({ agreement: z.object({ at: timestamp, source: text, text: z.string() }), type: z.literal('agreement') }),
  z.object({ type: z.literal('agreement-withdrawn') }),
  z.object({ dissent: z.object({ at: timestamp, decisionLabel: text, role, text: z.string() }), type: z.literal('dissent') }),
  z.object({ approval: approval.optional(), sha: text.optional(), type: z.literal('approved') }),
  z.object({ intent: z.object({
    approval,
    hook: mergeHookSchema.optional(),
    operationId: text,
    sourcePaneId: text,
    sourceSha: text,
    state: z.enum(['prepared', 'published', 'cleaned']),
    targetRef: text,
    targetSha: text,
  }).optional(), type: z.literal('merge-intent') }),
  z.object({ hook: mergeHookSchema, operationId: text, type: z.literal('merge-hook') }),
  z.object({ sha: text.optional(), type: z.literal('check-snapshot') }),
  z.object({ pending: z.boolean(), type: z.literal('check-execution') }),
  z.object({ step: nextStep.optional(), type: z.literal('recovery') }),
  z.object({ checkpoints: z.record(text, count).optional(), sourceUpdatedAt: timestamp.optional(), tokens: count, type: z.literal('usage') }),
  z.object({ type: z.literal('fix-attempts'), value: count }),
  z.object({ type: z.literal('design-floor'), value: count }),
  z.object({ snapshots: snapshots.optional(), type: z.literal('duel-snapshots') }),
  z.object({ paneId: text.optional(), type: z.literal('source-selected') }),
  z.object({ pause: limitPause.optional(), type: z.literal('limit-pause') }),
  z.object({ limits, type: z.literal('limits-extended') }),
  z.object({ decisionId: text.optional(), type: z.literal('resume-decision') }),
  z.object({ error: z.string().optional(), status, type: z.literal('status') }),
]);
const recordSchema = z.union([
  z.strictObject({ at: timestamp, events: z.array(eventSchema).min(1).max(MAX_RECORD_EVENTS), version: z.literal(1) }),
  z.strictObject({ at: timestamp, event: eventSchema }),
]);

interface JournalState {
  bytes: number;
  error?: string;
  needsNewline: boolean;
  repairAt?: number;
  run: TeamRun | null;
}

function runsDirectory(projectRoot: string): string {
  return join(getProjectMetadataDir(projectRoot), 'teams');
}

function journalPath(projectRoot: string, runId: string): string {
  if (!runId || runId === '.' || runId === '..' || basename(runId) !== runId) {
    throw new Error('Invalid team journal run id');
  }
  return join(runsDirectory(projectRoot), runId, EVENTS_FILE);
}

function applyRecord(run: TeamRun | null, events: TeamEvent[], at: number, projectRoot: string, runId: string): TeamRun {
  let draft = run;
  for (const event of events) {
    if (event.type === 'created' && (event.seed.id !== runId || resolve(event.seed.projectRoot) !== resolve(projectRoot))) {
      throw new Error('Team journal seed does not match its project root and run directory');
    }
    draft = reduceTeamEvent(draft, event, at);
  }
  if (!draft) throw new Error('Empty team journal record');
  return { ...draft, revision: (run?.revision ?? 0) + 1 };
}

function parseRecord(line: string) {
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error('Team journal record exceeds its size limit');
  const raw: unknown = JSON.parse(line);
  return recordSchema.parse(raw);
}

function incompleteJson(line: string): boolean {
  try {
    JSON.parse(line);
    return false;
  } catch (error) {
    if (!(error instanceof SyntaxError)) return false;
    if (/Unexpected end of JSON input|Unterminated string/i.test(error.message)) return true;
    const position = /at position (\d+)/.exec(error.message)?.[1];
    return position !== undefined && Number(position) === line.length;
  }
}

function replay(file: string, projectRoot: string, runId: string): JournalState {
  const bytes = readFileSync(file);
  const state: JournalState = { bytes: bytes.length, needsNewline: false, run: null };
  let offset = 0;
  let recordNumber = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end).toString('utf8');
    recordNumber += 1;
    try {
      const stored = parseRecord(line);
      const events = 'events' in stored ? stored.events : [stored.event];
      state.run = applyRecord(state.run, events, stored.at, projectRoot, runId);
    } catch (error) {
      if (newline === -1 && end - offset <= MAX_RECORD_BYTES && incompleteJson(line)) {
        state.repairAt = offset;
        log.warn('team', 'Recovering incomplete final team journal record before the next append', { file, recordNumber });
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        state.error = `Team journal recovery blocked at record ${recordNumber}: ${reason}`;
      }
      return state;
    }
    state.needsNewline = newline === -1;
    offset = end + 1;
  }
  return state;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error('Team journal write made no progress');
    offset += written;
  }
}

function durableAppend(file: string, bytes: Buffer, state: JournalState): void {
  const fd = openSync(file, 'a', 0o600);
  const originalLength = state.repairAt ?? state.bytes;
  try {
    if (state.repairAt !== undefined) ftruncateSync(fd, state.repairAt);
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    try {
      ftruncateSync(fd, originalLength);
      fsyncSync(fd);
    } catch (rollbackError) {
      log.error('team', 'Team journal write rollback failed; recovery is required', { error, file, rollbackError });
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

export function appendTeamEvents(projectRoot: string, runId: string, events: TeamEvent[], at: number): void {
  const file = journalPath(projectRoot, runId);
  const stored = recordSchema.parse({ at, events, version: 1 });
  const bytes = Buffer.from(`${JSON.stringify(stored)}\n`);
  if (bytes.length > MAX_RECORD_BYTES) throw new Error('Team journal record exceeds its size limit');
  const state = existsSync(file) ? replay(file, projectRoot, runId) : { bytes: 0, needsNewline: false, run: null };
  if (state.error) {
    log.error('team', state.error, { file, runId });
    throw new Error(state.error);
  }
  applyRecord(state.run, events, at, projectRoot, runId);
  mkdirSync(join(runsDirectory(projectRoot), runId), { mode: 0o700, recursive: true });
  durableAppend(file, state.needsNewline ? Buffer.concat([Buffer.from('\n'), bytes]) : bytes, state);
}

export function appendTeamEvent(projectRoot: string, runId: string, event: TeamEvent, at: number): void {
  appendTeamEvents(projectRoot, runId, [event], at);
}

function hasTrackedRuns(projectRoot: string, root: string): boolean {
  try {
    return execFileSync('git', ['ls-files', '--', root], { cwd: projectRoot, encoding: 'utf-8' }).trim().length > 0;
  } catch {
    return false;
  }
}

export function loadTeamRuns(projectRoot: string): TeamRun[] {
  const root = runsDirectory(projectRoot);
  if (!existsSync(root)) return [];
  if (hasTrackedRuns(projectRoot, root)) {
    log.warn('team', 'Ignoring team runs tracked by git', { projectRoot });
    return [];
  }
  const runs: TeamRun[] = [];
  for (const name of readdirSync(root)) {
    const file = journalPath(projectRoot, name);
    if (!existsSync(file)) continue;
    try {
      const state = replay(file, projectRoot, name);
      if (state.error) log.error('team', state.error, { file, runId: name });
      if (!state.run) continue;
      runs.push(state.error ? { ...state.run, error: state.error, next: undefined, status: 'failed' } : state.run);
    } catch (error) {
      log.error('team', 'Team journal recovery failed; run is unreadable', { error, runId: name });
    }
  }
  return runs;
}

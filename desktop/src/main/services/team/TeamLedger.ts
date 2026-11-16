import { randomUUID } from 'node:crypto';
import type { TeamEvent, TeamRun } from '../../../shared/team-types.js';
import { appendTeamEvents, loadTeamRuns } from './TeamRunStore.js';
import type { TeamFeedDraft } from './teamFeed.js';
import { reduceTeamEvent } from './teamProtocol.js';

interface PendingTransaction {
  at: number;
  draft: TeamRun | null;
  events: TeamEvent[];
  runId: string;
}

function executeSynchronous(operation: () => void): void {
  if (operation.constructor.name === 'AsyncFunction') throw new Error('Team transactions must be synchronous, not async');
  const result: unknown = operation();
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    throw new Error('Team transactions must be synchronous, not async');
  }
}

export class TeamLedger {
  private readonly runs = new Map<string, TeamRun>();
  private readonly loadedRoots = new Set<string>();
  private pending?: PendingTransaction;

  constructor(
    private readonly getProjectRoot: () => string,
    private readonly emitRun: (run: TeamRun) => void,
  ) {}

  active(): TeamRun[] {
    const root = this.getProjectRoot();
    this.ensureLoaded(root);
    return [...this.runs.values()].map((run) => this.find(run.id) ?? run).filter((run) => run.projectRoot === root);
  }

  list(): TeamRun[] {
    return this.active().sort((left, right) => right.createdAt - left.createdAt);
  }

  find(runId: string): TeamRun | undefined {
    if (this.pending?.runId === runId) return this.pending.draft ?? undefined;
    return this.runs.get(runId);
  }

  get(runId: string): TeamRun {
    const run = this.find(runId);
    if (!run) throw new Error(`Team run not found: ${runId}`);
    return run;
  }

  commit(runId: string, event: TeamEvent): TeamRun {
    const id = event.type === 'created' ? event.seed.id : runId;
    if (id !== runId) throw new Error('Team event run id does not match the requested run');
    if (this.pending) return this.commitDraft(id, event);
    const storedEvent = structuredClone(event);
    const at = Date.now();
    const current = this.runs.get(id) ?? null;
    const next = { ...reduceTeamEvent(current, storedEvent, at), revision: (current?.revision ?? 0) + 1 };
    appendTeamEvents(next.projectRoot, id, [storedEvent], at);
    this.runs.set(id, next);
    this.emitRun(next);
    return next;
  }

  transaction(runId: string, operation: () => void): void {
    if (this.pending) {
      this.nestedTransaction(runId, operation);
      return;
    }
    const pending: PendingTransaction = {
      at: Date.now(),
      draft: structuredClone(this.runs.get(runId) ?? null),
      events: [],
      runId,
    };
    this.pending = pending;
    let committed: TeamRun | undefined;
    try {
      executeSynchronous(operation);
      if (pending.events.length && pending.draft) {
        appendTeamEvents(pending.draft.projectRoot, runId, pending.events, pending.at);
        committed = pending.draft;
        this.runs.set(runId, committed);
      }
    } finally {
      this.pending = undefined;
    }
    if (committed) this.emitRun(committed);
  }

  feed(runId: string, draft: TeamFeedDraft): TeamRun {
    return this.commit(runId, { item: { ...draft, at: Date.now(), id: randomUUID() }, type: 'feed' });
  }

  lead(runId: string, text: string): TeamRun {
    return this.feed(runId, { kind: 'lead', text });
  }

  private commitDraft(runId: string, event: TeamEvent): TeamRun {
    const pending = this.pending;
    if (!pending || pending.runId !== runId) throw new Error('Cannot commit another run inside a team transaction');
    const storedEvent = structuredClone(event);
    const revision = (this.runs.get(runId)?.revision ?? 0) + 1;
    const next = { ...reduceTeamEvent(pending.draft, storedEvent, pending.at), revision };
    pending.events.push(storedEvent);
    pending.draft = next;
    return next;
  }

  private nestedTransaction(runId: string, operation: () => void): void {
    const pending = this.pending;
    if (!pending || pending.runId !== runId) throw new Error('Cannot nest a transaction for another team run');
    const draft = structuredClone(pending.draft);
    const eventCount = pending.events.length;
    try {
      executeSynchronous(operation);
    } catch (error) {
      pending.draft = draft;
      pending.events.length = eventCount;
      throw error;
    }
  }

  private ensureLoaded(root: string): void {
    if (!root || this.loadedRoots.has(root)) return;
    this.loadedRoots.add(root);
    for (const run of loadTeamRuns(root)) this.runs.set(run.id, run);
  }
}

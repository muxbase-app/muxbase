import {
  TEAM_DEFAULT_DURATION_MS,
  TEAM_DEFAULT_TOKEN_BUDGET,
  type TeamRun,
} from '../../../shared/team-types.js';
import type { TeamLedger } from './TeamLedger.js';
import { TeamUsageAccounting } from './TeamUsageAccounting.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export class TeamExecution {
  private readonly controllers = new Map<string, AbortController>();
  private readonly jobs = new Map<string, Set<Promise<unknown>>>();
  private readonly knownRuns = new Set<string>();
  private readonly accounting: TeamUsageAccounting;
  private shuttingDown = false;

  constructor(private readonly ledger: TeamLedger, private readonly dependencies: TeamWorkflowDependencies) {
    this.accounting = new TeamUsageAccounting(ledger, dependencies);
  }

  runs(): TeamRun[] {
    for (const run of this.ledger.active()) this.knownRuns.add(run.id);
    return [...this.knownRuns].map((id) => this.ledger.get(id));
  }

  signal(runId: string): AbortSignal {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    return controller.signal;
  }

  abort(runId: string): void {
    this.signal(runId);
    this.controllers.get(runId)?.abort();
  }

  resume(runId: string): void {
    if (this.shuttingDown || this.hasWork(runId)) throw new Error('The team cannot resume while prior operations are running or the app is shutting down');
    this.controllers.set(runId, new AbortController());
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const run of this.runs()) this.abort(run.id);
  }

  hasWork(runId?: string): boolean {
    return runId ? (this.jobs.get(runId)?.size ?? 0) > 0 : [...this.jobs.values()].some((jobs) => jobs.size > 0);
  }

  track<T>(runId: string, action: () => Promise<T>): Promise<T> {
    this.knownRuns.add(runId);
    const jobs = this.jobs.get(runId) ?? new Set<Promise<unknown>>();
    this.jobs.set(runId, jobs);
    const job = Promise.resolve().then(action);
    jobs.add(job);
    void job.finally(() => {
      jobs.delete(job);
      if (!jobs.size) this.jobs.delete(runId);
    }).catch(() => {});
    return job;
  }

  async drain(runId: string): Promise<void> {
    while (this.hasWork(runId)) await Promise.allSettled([...(this.jobs.get(runId) ?? [])]);
  }

  assert(run: TeamRun): void {
    if (this.shuttingDown || this.signal(run.id).aborted || run.limitPause || run.status === 'stopping' || run.status === 'stopped' || run.status === 'merged') {
      throw new Error('The team run is stopping or closed');
    }
    this.assertProject(run);
    const reason = this.limitReason(run);
    if (reason) throw new Error(reason);
  }

  assertProject(run: TeamRun): void {
    if (!this.dependencies.hasActiveProjectContext() || this.dependencies.getProjectRoot() !== run.projectRoot) {
      throw new Error('Open this team run’s project before acting on it');
    }
  }

  async mutation<T>(run: TeamRun, action: () => Promise<T>): Promise<T> {
    this.assert(run);
    return this.dependencies.runProjectMutation(async () => {
      this.assert(this.ledger.get(run.id));
      const result = await action();
      this.assert(this.ledger.get(run.id));
      return result;
    });
  }

  limitReason(run: TeamRun): string | undefined {
    if (Date.now() - run.createdAt >= (run.limits?.maxDurationMs ?? TEAM_DEFAULT_DURATION_MS)) {
      return 'The team reached its absolute run deadline.';
    }
    this.accounting.observe(run);
    if ((this.ledger.get(run.id).tokenUsage ?? 0) >= (run.limits?.maxTokens ?? TEAM_DEFAULT_TOKEN_BUDGET)) {
      return 'The team reached its backend-observed token budget. Already-spent tokens cannot be undone.';
    }
    return undefined;
  }

  observeUsage(runId: string): void {
    this.accounting.observe(this.ledger.get(runId));
  }

}

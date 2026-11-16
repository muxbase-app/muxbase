import type { TeamMember, TeamRun } from '../../../shared/team-types.js';
import type { TeamLedger } from './TeamLedger.js';
import { teamSlotConfig, unregisteredTeamPanes } from './TeamPaneOwnership.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export class TeamUsageAccounting {
  private readonly usage = new Map<string, Map<string, number>>();
  private readonly offsets = new Map<string, number>();

  constructor(private readonly ledger: TeamLedger, private readonly dependencies: TeamWorkflowDependencies) {}

  observe(run: TeamRun): void {
    if (this.dependencies.getProjectRoot() !== run.projectRoot) return;
    const observed = this.usage.get(run.id) ?? new Map<string, number>(Object.entries(run.usageCheckpoints ?? {}));
    this.usage.set(run.id, observed);
    let sourceUpdatedAt = run.usageSourceUpdatedAt;
    const observe = (member: Pick<TeamMember, 'paneId' | 'role'>, prefix?: string) => {
      const updatedAt = this.observeMember(observed, member, prefix);
      if (updatedAt !== undefined) sourceUpdatedAt = Math.max(sourceUpdatedAt ?? 0, updatedAt);
    };
    for (const member of run.members) observe(member);
    for (const pane of unregisteredTeamPanes(run, this.dependencies)) {
      const config = teamSlotConfig(run, pane);
      observe({ paneId: pane.id, role: config?.role ?? 'developer' }, config?.role ?? `orphan:${pane.id}`);
    }
    const observedTotal = [...observed.values()].reduce((sum, value) => sum + value, 0);
    if (!this.offsets.has(run.id)) {
      if (!run.usageCheckpoints && !observed.size && run.tokenUsage) return;
      const restored = Object.values(run.usageCheckpoints ?? Object.fromEntries(observed)).reduce((sum, value) => sum + value, 0);
      this.offsets.set(run.id, Math.max(0, (run.tokenUsage ?? 0) - restored));
    }
    const total = Math.max(run.tokenUsage ?? 0, observedTotal + (this.offsets.get(run.id) ?? 0));
    const checkpoints = Object.fromEntries(observed);
    if (total !== (run.tokenUsage ?? 0) || sourceUpdatedAt !== run.usageSourceUpdatedAt
      || JSON.stringify(checkpoints) !== JSON.stringify(run.usageCheckpoints ?? {})) {
      this.ledger.commit(run.id, { checkpoints, sourceUpdatedAt, tokens: total - (run.tokenUsage ?? 0), type: 'usage' });
    }
  }

  private observeMember(observed: Map<string, number>, member: Pick<TeamMember, 'paneId' | 'role'>, prefix: string = member.role): number | undefined {
    const session = this.dependencies.getSession(member.paneId);
    const provider = this.dependencies.getPaneUsage?.(member.paneId);
    if (provider === undefined && !session) return;
    const orphanPrefix = `orphan:${member.paneId}`;
    const sessionPrefix = session && observed.has(`${orphanPrefix}:${session.sessionId}`) ? orphanPrefix : prefix;
    const key = session ? `${sessionPrefix}:${session.sessionId}` : `provider:${prefix}:${member.paneId}:${this.dependencies.getPaneActivity(member.paneId)?.paneIncarnationId ?? ''}`;
    const total = provider ?? (session?.metrics.totalTokens ?? 0) + (session?.subagents.reduce((sum, agent) => sum + agent.metrics.totalTokens, 0) ?? 0);
    observed.set(key, Math.max(observed.get(key) ?? 0, total));
    return provider === undefined ? session?.lastUpdateTime : undefined;
  }
}

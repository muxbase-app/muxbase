import type { CSSProperties } from 'react';
import type { TeamMember, TeamRun } from '../../../shared/team-types';
import { formatAgentLabel } from '../../lib/formatters';
import { usePaneActivityStore, useUiStore } from '../../stores';
import { TeamBraid } from './TeamBraid';
import { TeamLedger } from './TeamLedger';
import { TeamRunUsage } from './TeamRunUsage';
import { modeLabel, ROLE_COLORS, roleMark, roleName, runStats } from './teamViewModel';

function CrewMember({ member, run }: Readonly<{ member: TeamMember; run: TeamRun }>) {
  const focusPane = useUiStore((s) => s.focusPane);
  const state = usePaneActivityStore((s) => s.activityByPaneId[member.paneId]?.state) ?? 'unknown';
  const name = roleName(run, member.role);
  return (
    <li className="team-member" style={{ '--c': ROLE_COLORS[member.role] } as CSSProperties}>
      <span aria-hidden="true" className="team-crew" data-state={state}>{roleMark(run, member.role)}<i /></span>
      <span className="team-member-who">
        <b>{name}</b>
        <small>{formatAgentLabel(member.agent)} · {member.readOnly ? 'Read-only' : 'Isolated writer'} · {state}</small>
      </span>
      <button aria-label={`Open ${name} pane`} className="team-quiet" onClick={() => focusPane(member.paneId)} type="button">Open pane</button>
    </li>
  );
}

export function TeamRunContext({ run }: Readonly<{ run: TeamRun }>) {
  const stats = runStats(run);
  return (
    <div className="team-context">
      <section>
        <h3>Brief</h3>
        <p className="team-context-brief">{run.brief}</p>
      </section>
      <section>
        <h3>Team · {modeLabel(run)}</h3>
        <ul className="team-members">
          {run.members.map((member) => <CrewMember key={member.paneId} member={member} run={run} />)}
        </ul>
      </section>
      <section>
        <h3>Limits</h3>
        <TeamRunUsage run={run} />
      </section>
      {stats.length > 0 && (
        <section>
          <h3>Run</h3>
          <p>{stats.join(' · ')}</p>
        </section>
      )}
      {run.approval && (
        <section>
          <h3>Workspace</h3>
          <p>{run.approval.kind === 'waiver' ? 'Reasoned waiver' : 'Approved snapshot'} <code>{run.approval.snapshotSha.slice(0, 10)}</code></p>
        </section>
      )}
      <TeamLedger run={run} />
      {run.mode !== 'pair' && run.rounds.length > 0 && <details className="team-alignment"><summary>Agreement history</summary><TeamBraid run={run} /></details>}
    </div>
  );
}

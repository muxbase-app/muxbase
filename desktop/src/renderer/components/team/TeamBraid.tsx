import { useEffect, useMemo, useRef, useState } from 'react';
import type { TeamRoleId, TeamRoundKind, TeamRun } from '../../../shared/team-types';
import { braidColumns, braidKinds, ROLE_COLORS, roleName, type BraidCluster, type BraidColumn } from './teamViewModel';

const WIDTH = 320;
const HEIGHT = 196;
const PAD = 26;
const STRAND_GAP = 7;
const MAX_LABEL_CHARS = 30;
const KIND_LABELS: Record<TeamRoundKind, string> = { build: 'Build', design: 'Design', review: 'Review' };

function memberY(column: BraidColumn, role: TeamRoleId): number | undefined {
  for (const cluster of column.clusters) {
    const index = cluster.members.indexOf(role);
    if (index >= 0) return cluster.y + (index - (cluster.members.length - 1) / 2) * STRAND_GAP;
  }
  return undefined;
}

function columnX(index: number, count: number): number {
  return count === 1 ? WIDTH / 2 : PAD + (index * (WIDTH - PAD * 2)) / (count - 1);
}

function Strand({ columns, freshFrom, role }: Readonly<{ columns: BraidColumn[]; freshFrom: number; role: TeamRoleId }>) {
  const color = ROLE_COLORS[role];
  return (
    <>
      {columns.slice(1).map((column, offset) => {
        const index = offset + 1;
        const from = memberY(columns[index - 1], role);
        const to = memberY(column, role);
        if (from === undefined || to === undefined) return null;
        const x0 = columnX(index - 1, columns.length);
        const x1 = columnX(index, columns.length);
        const middle = (x0 + x1) / 2;
        return (
          <path
            className={index >= freshFrom ? 'team-strand team-strand-new' : 'team-strand'}
            d={`M${x0} ${from}C${middle} ${from},${middle} ${to},${x1} ${to}`}
            key={index}
            pathLength={1}
            stroke={color}
          />
        );
      })}
      {columns.map((column, index) => {
        const y = memberY(column, role);
        return y === undefined ? null : (
          <circle cx={columnX(index, columns.length)} cy={y} fill={color} key={index} r={3} stroke="var(--bg)" />
        );
      })}
    </>
  );
}

function ClusterLabel({ cluster, count, index, single }: Readonly<{ cluster: BraidCluster; count: number; index: number; single: boolean }>) {
  const above = cluster.y < 100 || single;
  const offset = cluster.members.length * 3.5 + 8;
  const y = cluster.y + (above ? -offset : offset + 7);
  const atEnd = index === count - 1 && count > 1;
  const atStart = index === 0;
  const anchor = atEnd ? 'end' : atStart ? 'start' : 'middle';
  const x = atEnd ? WIDTH - 2 : atStart ? 2 : columnX(index, count);
  return <text className="team-cluster" textAnchor={anchor} x={x} y={y}>{cluster.label.length > MAX_LABEL_CHARS ? `${cluster.label.slice(0, MAX_LABEL_CHARS - 1)}…` : cluster.label}</text>;
}

function BraidChart({ columns, kind, roles }: Readonly<{ columns: BraidColumn[]; kind: TeamRoundKind; roles: TeamRoleId[] }>) {
  const previous = useRef({ count: columns.length, kind });
  const freshFrom = previous.current.kind === kind ? previous.current.count : columns.length;
  useEffect(() => {
    previous.current = { count: columns.length, kind };
  }, [columns.length, kind]);
  return (
    <svg aria-label="How each role's position moved across rounds" className="team-braid" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      {columns.map((column, index) => {
        const x = columnX(index, columns.length);
        return (
          <g key={column.label}>
            <line stroke="var(--divider)" x1={x} x2={x} y1={16} y2={176} />
            <text
              className="team-round-label"
              textAnchor={index === 0 ? 'start' : index === columns.length - 1 ? 'end' : 'middle'}
              x={index === 0 ? 2 : index === columns.length - 1 ? WIDTH - 2 : x}
              y={192}
            >
              {column.label}
            </text>
            {column.fault && (
              <g className="team-fault">
                <circle cx={x} cy={100} fill="none" r={9} stroke="var(--agent-waiting)" strokeWidth={1.5} />
                <path d={`M${x} 62V138`} stroke="var(--agent-waiting)" strokeDasharray="2 3" />
              </g>
            )}
          </g>
        );
      })}
      {roles.map((role) => <Strand columns={columns} freshFrom={freshFrom} key={role} role={role} />)}
      {columns.map((column, index) => column.clusters.map((cluster) => (
        <ClusterLabel
          cluster={cluster}
          count={columns.length}
          index={index}
          key={`${column.label}-${cluster.label}`}
          single={column.clusters.length === 1}
        />
      )))}
    </svg>
  );
}

export function TeamBraid({ run }: Readonly<{ run: TeamRun }>) {
  const kinds = braidKinds(run);
  const latest = kinds.at(-1);
  const [selected, setSelected] = useState<TeamRoundKind | null>(null);
  const kind = selected && kinds.includes(selected) ? selected : latest;
  const columns = useMemo(() => (kind ? braidColumns(run, kind) : []), [kind, run]);
  const roles = useMemo(() => [...new Set(columns.flatMap((column) => column.clusters.flatMap((cluster) => cluster.members)))], [columns]);

  return (
    <section data-testid="team-alignment">
      <header className="team-rail-title">
        <span>Alignment</span>
        <div className="team-braid-tabs">
          {kinds.map((candidate) => (
            <button
              className={candidate === kind ? 'on' : ''}
              key={candidate}
              onClick={() => setSelected(candidate)}
              type="button"
            >
              {run.mode === 'duel' && candidate === 'review' ? 'Compare / review' : KIND_LABELS[candidate]}
            </button>
          ))}
        </div>
      </header>
      {kind && columns.length > 0
        ? <BraidChart columns={columns} kind={kind} roles={roles} />
        : <p className="team-empty-note">Positions appear after the first sealed round.</p>}
      <div className="team-legend">
        {run.members.map((member) => (
          <span key={member.role}>
            <i style={{ background: ROLE_COLORS[member.role] }} />
            {roleName(run, member.role)}
          </span>
        ))}
      </div>
    </section>
  );
}

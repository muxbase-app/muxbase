import type { AgentName } from 'muxbase/core';
import type { CSSProperties } from 'react';
import type { TeamRoleId } from '../../../shared/team-types';
import { formatAgentLabel } from '../../lib/formatters';
import { AgentBrandIcon } from '../shared/agent-brand-icons';
import type { RosterRow } from './teamLaunchModel';
import { ROLE_COLORS, ROLE_MARKS } from './teamViewModel';

export const ROLE_COPY: Record<TeamRoleId, { description: string; name: string }> = {
  architect: { description: 'Reviews design and boundaries', name: 'Architect' },
  developer: { description: 'Writes the code in its own worktree', name: 'Developer' },
  domain: { description: 'Reviews domain rules and contracts', name: 'Domain expert' },
  tester: { description: 'Reviews failure paths and coverage gaps', name: 'Tester' },
};

function RoleMark({ copy, onToggle, row }: Readonly<{ copy: { name: string }; onToggle: () => void; row: RosterRow }>) {
  if (row.role === 'developer') return <span aria-hidden="true" className="team-role-mark">{ROLE_MARKS[row.role]}</span>;
  return (
    <button aria-label={`${row.enabled ? 'Remove' : 'Add'} ${copy.name}`} aria-pressed={row.enabled} className="team-role-mark" onClick={onToggle} type="button">
      {ROLE_MARKS[row.role]}
    </button>
  );
}

export function TeamRoster({ all, onChange, readers, rows }: Readonly<{
  all: AgentName[]; onChange: (row: RosterRow) => void; readers: AgentName[]; rows: RosterRow[];
}>) {
  return (
    <div className="team-roster">
      {rows.map((row) => {
        const copy = ROLE_COPY[row.role];
        return (
          <div className={row.enabled ? 'team-role' : 'team-role off'} key={row.role} style={{ '--c': ROLE_COLORS[row.role] } as CSSProperties}>
            <RoleMark copy={copy} onToggle={() => onChange({ ...row, enabled: !row.enabled })} row={row} />
            <span><b>{copy.name}</b><small>{copy.description}</small></span>
            <div aria-label={`${copy.name} agent`} className="team-mini-seg" data-testid={`team-role-${row.role}`} role="radiogroup">
              {(row.role === 'developer' ? all : readers).map((agent) => (
                <label key={agent}>
                  <input checked={agent === row.agent} name={`team-role-${row.role}`} onChange={() => onChange({ ...row, agent, enabled: true })} type="radio" value={agent} />
                  <AgentBrandIcon agent={agent} size="sm" />{formatAgentLabel(agent)}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

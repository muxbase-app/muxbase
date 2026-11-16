import type { AgentName } from 'muxbase/core';
import { ChevronDown } from 'lucide-react';
import { formatAgentLabel } from '../../lib/formatters';
import { AgentBrandIcon } from '../shared/agent-brand-icons';

export function TeamAgentField({ agents, label, onChange, value }: Readonly<{
  agents: AgentName[]; label: string; onChange: (agent: AgentName) => void; value?: AgentName;
}>) {
  return (
    <label className="team-agent-field">
      <span className="team-agent-label">{label}</span>
      <span className="team-agent-select">
        {value && <AgentBrandIcon agent={value} className="team-agent-icon" size="sm" />}
        <select aria-label={label} onChange={(event) => {
          const agent = agents.find((item) => item === event.target.value);
          if (agent) onChange(agent);
        }} value={value ?? ''}>
          {!value && <option value="" disabled>{agents.length === 0 ? 'No available agent' : 'Choose an agent'}</option>}
          {value && !agents.includes(value) && <option value={value} disabled>{formatAgentLabel(value)} (not available)</option>}
          {agents.map((agent) => <option key={agent} value={agent}>{formatAgentLabel(agent)}</option>)}
        </select>
        <ChevronDown aria-hidden="true" className="team-agent-chevron" />
      </span>
    </label>
  );
}

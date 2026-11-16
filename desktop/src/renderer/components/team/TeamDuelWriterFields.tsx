import type { AgentName } from 'muxbase/core';
import { useEffect, useState } from 'react';
import type { AgentDefaultsResponse } from '../../../shared/ipc-types';
import { getAgentDefaults } from '../../api/agent-defaults.api';
import { useTeamStore } from '../../stores/team.store';
import { AgentTuning } from '../create/AgentTuning';
import { TeamAgentField } from './TeamAgentField';
import type { TeamLaunchDraft } from './useTeamLaunchDraft';

export function TeamDuelWriterFields({ agents, draft, onChange }: Readonly<{
  agents: AgentName[]; draft: TeamLaunchDraft; onChange: (draft: TeamLaunchDraft) => void;
}>) {
  const projectRoot = useTeamStore((s) => s.activeProjectRoot);
  const [defaults, setDefaults] = useState<AgentDefaultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void getAgentDefaults(projectRoot ?? undefined).then((value) => {
      if (!disposed) setDefaults(value);
    }).catch((failure: unknown) => {
      if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { disposed = true; };
  }, [projectRoot]);
  return (
    <>
      {(['a', 'b'] as const).map((side) => {
        const agent = side === 'a' ? draft.writer : draft.secondWriter;
        const tuning = side === 'a' ? draft.writerTuning : draft.secondWriterTuning;
        const setTuning = (next: typeof tuning) => onChange(side === 'a' ? { ...draft, writerTuning: next } : { ...draft, secondWriterTuning: next });
        const label = side === 'a' ? 'Writer A' : 'Writer B';
        return (
          <div aria-label={label} className="team-duel-writer-fields" data-testid={`team-writer-${side}`} key={side} role="group">
            <TeamAgentField agents={agents} label={label} onChange={(next) => onChange(side === 'a'
              ? { ...draft, writer: next, writerTuning: {} } : { ...draft, secondWriter: next, secondWriterTuning: {} })} value={agent} />
            <AgentTuning
              agent={agent} defaults={agent ? defaults?.[agent] : undefined} defaultsLoading={!defaults && !error}
              effort={tuning.effort} model={tuning.model} onEffortChange={(effort) => setTuning({ ...tuning, effort })}
              onModelChange={(model) => setTuning({ ...tuning, model })} opencodeDefaults={defaults?.opencode}
            />
          </div>
        );
      })}
      {error && <p role="alert">Could not load agent tuning defaults: {error}</p>}
    </>
  );
}

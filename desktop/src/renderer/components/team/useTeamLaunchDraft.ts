import type { AgentName } from 'muxbase/core';
import { useEffect, useRef, useState } from 'react';
import type { TeamMode } from '../../../shared/team-settings';
import type { DuelSideConfig } from '../../../shared/ipc-types';
import type { TeamPolicy } from '../../../shared/team-types';
import { useTeamAgents } from '../../hooks/useTeamAgents';
import { useElectronSettingsStore } from '../../stores/electron-settings.store';
import { initialRoster, preferredAgent, presentAgents, type RosterRow } from './teamLaunchModel';

export interface TeamLaunchDraft {
  maxFixRounds: string;
  maxMinutes: string;
  maxTokens: string;
  mode: TeamMode;
  policy: TeamPolicy;
  reviewer?: AgentName;
  rows: RosterRow[];
  secondWriter?: AgentName;
  secondWriterTuning: Omit<DuelSideConfig, 'agent'>;
  writer?: AgentName;
  writerTuning: Omit<DuelSideConfig, 'agent'>;
}

export function useTeamLaunchDraft() {
  const catalog = useTeamAgents();
  const settings = useElectronSettingsStore((s) => s.settings);
  const load = useElectronSettingsStore((s) => s.load);
  const loadError = useElectronSettingsStore((s) => s.loadError);
  const initialized = useRef(false);
  const [draft, setDraft] = useState<TeamLaunchDraft | null>(null);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (initialized.current || !settings || catalog.loading || catalog.error) return;
    initialized.current = true;
    const writer = settings.teamWriterAgent;
    const secondWriter = catalog.all.includes(settings.teamReviewerAgent)
      ? preferredAgent(catalog.all, settings.teamReviewerAgent, [writer]) : settings.teamReviewerAgent;
    setDraft({
      maxFixRounds: String(settings.teamMaxFixRounds),
      maxMinutes: String(settings.teamTimeLimitMinutes),
      maxTokens: String(settings.teamTokenBudget),
      mode: settings.teamDefaultMode,
      policy: settings.teamPolicy,
      reviewer: settings.teamReviewerAgent,
      rows: initialRoster(settings),
      secondWriter,
      secondWriterTuning: {},
      writer,
      writerTuning: {},
    });
  }, [catalog, settings]);
  const excluded = draft?.mode === 'pair' ? presentAgents([draft.writer]) : [];
  const reviewerOptions = catalog.readers.filter((agent) => !excluded.includes(agent));
  const reviewer = draft?.reviewer && catalog.readers.includes(draft.reviewer)
    ? preferredAgent(reviewerOptions, draft.reviewer) : undefined;
  return { catalog, draft, load, loadError, reviewer, reviewerOptions, setDraft };
}

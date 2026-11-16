import { type CSSProperties, useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { formatAgentLabel } from '../../lib/formatters';
import { usePaneStore } from '../../stores';
import { usePaneActivityStore } from '../../stores/pane-activity.store';
import { useUiStore } from '../../stores/ui.store';
import { TeamDiffDialog } from './TeamDiffDialog';
import { ROLE_COLORS, roleMark } from './teamViewModel';

const DUEL_ROLES = ['developer', 'architect'] as const;

function DuelCandidate({ index, run }: Readonly<{ index: number; run: TeamRun }>) {
  const focusPane = useUiStore((s) => s.focusPane);
  const [diffOpen, setDiffOpen] = useState(false);
  const role = DUEL_ROLES[index];
  const member = run.members.find((candidate) => candidate.role === role);
  const pane = usePaneStore((s) => s.panes.find((candidate) => candidate.id === member?.paneId));
  const activity = usePaneActivityStore((s) => (member ? s.activityByPaneId[member.paneId]?.state : undefined));
  const snapshot = run.duelSnapshots?.[role];
  const side = run.duelSides?.[index];
  const letter = index === 0 ? 'A' : 'B';
  const winner = Boolean(member && run.selectedSourceId === member.paneId);
  const agent = member?.agent ?? side?.agent;
  return (
    <div className={winner ? 'team-duel-candidate chosen' : 'team-duel-candidate'} data-testid={`team-duel-writer-${letter.toLowerCase()}`} style={{ '--c': ROLE_COLORS[role] } as CSSProperties}>
      <div className="team-duel-head">
        <span aria-hidden="true" className="team-mark lg">{roleMark(run, role)}</span>
        <div>
          <h3>Writer {letter}</h3>
          <small>{[agent ? formatAgentLabel(agent) : 'Starting', side?.model, side?.effort].filter(Boolean).join(' · ')}</small>
        </div>
      </div>
      <p className="team-duel-facts">
        <span>{winner ? 'Chosen by you' : activity ?? 'Starting'}</span>
        {snapshot && <span className="team-mono">{snapshot.snapshotSha.slice(0, 7)}</span>}
        {snapshot && <span className={snapshot.checksPassed ? 'ok' : 'bad'}>checks {snapshot.checksPassed ? 'passed' : 'not passed'}</span>}
      </p>
      {member && (
        <div className="team-duel-actions">
          <button className="team-link-button" disabled={!pane} onClick={() => setDiffOpen(true)} type="button">View writer {letter} changes</button>
          <button className="team-link-button" onClick={() => focusPane(member.paneId)} type="button">Open writer {letter}</button>
        </div>
      )}
      <TeamDiffDialog
        description="Live candidate diff. The comparator's recommendation is advisory; you choose the winner."
        onClose={() => setDiffOpen(false)}
        open={diffOpen}
        pane={pane}
        title={`Writer ${letter} changes`}
      />
    </div>
  );
}

function duelProgress(run: TeamRun, comparisonOpen: boolean, comparisonClosed: boolean): string {
  if (run.selectedSourceId) return 'Winner selected. Review and checks still gate your merge.';
  if (comparisonClosed) return 'Comparison complete. Compare both diffs, then choose a writer.';
  return comparisonOpen ? 'Comparator is reviewing the sealed snapshots.' : 'Comparison starts after both writers finish.';
}

export function TeamDuelCandidates({ run }: Readonly<{ run: TeamRun }>) {
  if (run.mode !== 'duel') return null;
  const comparison = [...run.rounds].reverse().find((round) => round.comparison);
  const recommendation = comparison?.closedAt ? comparison.positions.tester?.supports : undefined;
  return (
    <section aria-label="Duel candidates" className="team-duel" data-testid="team-duel-candidates">
      <div className="team-duel-grid">
        {DUEL_ROLES.map((role, index) => <DuelCandidate index={index} key={role} run={run} />)}
      </div>
      <p className="team-note-line">
        {duelProgress(run, Boolean(comparison), Boolean(comparison?.closedAt))}
        {recommendation && ` Comparator recommendation: writer ${recommendation === 'developer' ? 'A' : 'B'}. This is not merge approval.`}
      </p>
    </section>
  );
}

import { Check, PanelRight, Plus, Square, X } from 'lucide-react';
import { useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { useTeamStore } from '../../stores/team.store';
import { type ModalMotionPreset, ModalSurface } from '../shared/ModalSurface';
import { TeamRunContext } from './TeamRunContext';
import { TeamTokenMeter } from './TeamRunUsage';
import { gateViews, type GateState, modeLabel } from './teamViewModel';
import { useStopRun } from './useStopRun';

const STATUS_LABELS: Record<TeamRun['status'], string> = {
  failed: 'Failed',
  merged: 'Merged',
  ready: 'Ready to merge',
  running: 'Working',
  starting: 'Starting',
  stopped: 'Stopped',
  stopping: 'Stopping',
  waiting: 'Needs you',
};
const CONTEXT_MOTION: ModalMotionPreset = {
  animate: { x: 0 },
  exit: { x: 24 },
  initial: { x: 24 },
  transition: { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] },
};

function StepMark({ state }: Readonly<{ state: GateState }>) {
  if (state === 'done') return <Check />;
  return state === 'failed' ? <X /> : null;
}

function RunStages({ run }: Readonly<{ run: TeamRun }>) {
  return (
    <ol aria-label="Run stages" className="team-steps" data-testid="team-gates">
      {gateViews(run).map((gate) => (
        <li aria-current={gate.current ? 'step' : undefined} className={`team-step ${gate.state}`} data-gate={gate.id} data-state={gate.state} key={gate.id}>
          <span aria-hidden="true" className="team-step-mark"><StepMark state={gate.state} /></span>
          <span className="team-step-label">{gate.label}{gate.state === 'failed' ? ' failed' : ''}</span>
        </li>
      ))}
    </ol>
  );
}

function RunTitle({ run }: Readonly<{ run: TeamRun }>) {
  const runs = useTeamStore((s) => s.runs);
  const selectRun = useTeamStore((s) => s.selectRun);
  if (runs.length < 2) return <h1 className="team-title" title={run.title}>{run.title}</h1>;
  return (
    <select aria-label="Team run" className="team-title" onChange={(event) => selectRun(event.target.value)} value={run.id}>
      {runs.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
    </select>
  );
}

export function TeamRunHeader({ run }: Readonly<{ run: TeamRun }>) {
  const setLaunchOpen = useTeamStore((s) => s.setLaunchOpen);
  const [contextOpen, setContextOpen] = useState(false);
  const { canStop, dialog, requestStop, stopping } = useStopRun(run);
  const openContext = () => setContextOpen(true);
  return (
    <header className="team-head">
      <div className="team-head-row">
        <RunTitle run={run} />
        <span aria-atomic="true" aria-label="Run status" aria-live="polite" className="team-pill" data-status={run.status} data-testid="team-status" role="status">
          <i aria-hidden="true" />{STATUS_LABELS[run.status]}
        </span>
        <span className="team-chip" data-testid="team-run-mode">{modeLabel(run)}</span>
        <div className="team-head-actions">
          <TeamTokenMeter onOpen={openContext} run={run} />
          <button aria-haspopup="dialog" className="team-quiet" onClick={openContext} type="button">
            <PanelRight aria-hidden="true" /><span className="team-collapsible-label">Run context</span>
          </button>
          {canStop && !run.error && (
            <button className="team-danger-ghost" data-testid="team-stop" disabled={stopping} onClick={requestStop} type="button">
              <Square aria-hidden="true" />Stop
            </button>
          )}
          <button className="team-ghost" data-testid="team-new-run" onClick={() => setLaunchOpen(true)} type="button">
            <Plus aria-hidden="true" /><span className="team-collapsible-label">New run</span>
          </button>
        </div>
      </div>
      <RunStages run={run} />
      {dialog}
      <ModalSurface label="Run context" onClose={() => setContextOpen(false)} open={contextOpen} panelClassName="team-context-panel" panelMotion={CONTEXT_MOTION}>
        <header>
          <h2>Run context</h2>
          <button aria-label="Close run context" className="team-icon-button" onClick={() => setContextOpen(false)} type="button"><X aria-hidden="true" /></button>
        </header>
        <TeamRunContext run={run} />
      </ModalSurface>
    </header>
  );
}

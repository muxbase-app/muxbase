import { X } from 'lucide-react';
import { type CSSProperties, type FormEvent, useId, useRef, useState } from 'react';
import { DEFAULT_TEAM_SETTINGS } from '../../../shared/team-settings';
import {
  TEAM_ACCEPT_OPTION,
  TEAM_EXTEND_OPTION,
  TEAM_SEND_BACK_OPTION,
  TEAM_STOP_OPTION,
  type TeamDecideRequest,
  type TeamDecision,
  type TeamDecisionOption,
  type TeamRun,
} from '../../../shared/team-types';
import { decideTeamRun } from '../../api/team.api';
import { useNotificationStore } from '../../stores';
import { useElectronSettingsStore } from '../../stores/electron-settings.store';
import { TeamDuelCandidates } from './TeamDuelCandidates';
import { limitExtension, type TeamLimitDraft, TeamLimitFields } from './TeamLimitFields';
import { activeDecision, decisionOutcome, ROLE_COLORS, roleMark, roleName } from './teamViewModel';

const RISK_ROWS = [['Gain', 'gain'], ['Cost', 'cost'], ['Risk', 'risk']] as const;

function OptionCard({ disabled, name, onPick, option, run, selected }: Readonly<{
  disabled: boolean; name: string; onPick: (id: string) => void; option: TeamDecisionOption; run: TeamRun; selected: boolean;
}>) {
  const id = useId();
  const risks = RISK_ROWS.filter(([, key]) => option[key]);
  return (
    <label className={option.id === TEAM_ACCEPT_OPTION ? 'team-option risky' : 'team-option'}>
      <input
        aria-describedby={`${id}-detail`}
        aria-labelledby={`${id}-title`}
        checked={selected}
        data-option-id={option.id}
        data-testid="team-decision-option"
        disabled={disabled}
        name={name}
        onChange={() => onPick(option.id)}
        type="radio"
        value={option.id}
      />
      <span className="team-option-text">
        <span className="team-option-title" id={`${id}-title`}>{option.title}</span>
        <span className="team-option-detail" id={`${id}-detail`}>
          {option.summary && <span className="team-option-sum">{option.summary}</span>}
          {risks.length > 0 && (
            <span className="team-gcr">
              {risks.map(([label, key]) => <span key={key}><i>{label}</i>{option[key]}</span>)}
            </span>
          )}
          {option.holders.length > 0 && (
            <span className="team-backers">
              <span aria-hidden="true">
                {option.holders.map((role) => <i key={role} style={{ '--c': ROLE_COLORS[role] } as CSSProperties}>{roleMark(run, role)}</i>)}
              </span>
              {option.holders.map((role) => roleName(run, role)).join(', ')}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}

function ResolvedDecision({ decision }: Readonly<{ decision: TeamDecision }>) {
  return (
    <p className="team-sys" data-testid="team-decision-resolved">
      <span><b>Decided by you</b> · {decision.label} · {decisionOutcome(decision)}{decision.note ? ` — ${decision.note}` : ''}</span>
    </p>
  );
}

function useDecide() {
  const addToast = useNotificationStore((s) => s.addToast);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const decide = async (request: TeamDecideRequest) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const response = await decideTeamRun(request);
      if (!response.success) addToast(response.error ?? 'Could not save your decision', 'error');
    } catch (error) {
      addToast(`Could not save your decision: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return { decide, pending };
}

function useLimitDraft(run: TeamRun): [TeamLimitDraft, (draft: TeamLimitDraft) => void] {
  const defaults = useElectronSettingsStore((s) => s.settings);
  const [edited, setEdited] = useState<TeamLimitDraft | null>(null);
  const budget = defaults?.teamTokenBudget ?? DEFAULT_TEAM_SETTINGS.teamTokenBudget;
  return [edited ?? {
    minutes: String(defaults?.teamTimeLimitMinutes ?? DEFAULT_TEAM_SETTINGS.teamTimeLimitMinutes),
    tokens: String(Math.max(run.limits?.maxTokens ?? 0, (run.tokenUsage ?? 0) + budget)),
  }, setEdited];
}

function SendBackForm({ onSubmit, pending }: Readonly<{ onSubmit: (note: string) => void; pending: boolean }>) {
  const [note, setNote] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim()) onSubmit(note.trim());
  };
  return (
    <form className="team-sendback" onSubmit={submit}>
      <textarea
        aria-label="Note for the team"
        autoFocus
        disabled={pending}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What should the team reconsider?"
        rows={2}
        value={note}
      />
      <button className="team-ghost" disabled={pending || !note.trim()} type="submit">Send back</button>
    </form>
  );
}

function OpenDecision({ decision, onClose, run }: Readonly<{ decision: TeamDecision; onClose?: () => void; run: TeamRun }>) {
  const titleId = useId();
  const { decide, pending } = useDecide();
  const [selected, setSelected] = useState<string | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [sendingBack, setSendingBack] = useState(false);
  const [limits, setLimits] = useLimitDraft(run);
  const extension = limitExtension(run, limits);
  const needsExtension = decision.kind === 'limit' && selected === TEAM_EXTEND_OPTION;
  const needsWaiverReason = selected === TEAM_ACCEPT_OPTION;
  const canSendBack = decision.kind === 'design' || decision.kind === 'approval';
  const incomplete = !selected || (needsWaiverReason && !waiverReason.trim()) || (needsExtension && !extension);
  const base = { decisionId: decision.id, runId: run.id };

  const confirm = () => {
    if (!selected || incomplete) return;
    void decide({
      ...base,
      note: needsWaiverReason ? waiverReason.trim() : undefined,
      optionId: selected,
      ...(needsExtension && extension ? { extension } : {}),
    });
  };

  return (
    <section aria-labelledby={titleId} className="team-decision" data-testid="team-decision">
      <header className="team-decision-head">
        <div>
          <span className="team-kicker">Your call · {decision.label}</span>
          <h2 id={titleId}>{decision.title}</h2>
          <p>{decision.why}</p>
        </div>
        {onClose && <button aria-label="Close decision" className="team-icon-button" onClick={onClose} type="button"><X aria-hidden="true" /></button>}
      </header>
      <div aria-label="Decision details" className="team-decision-body" role="region" tabIndex={0}>
        <div aria-labelledby={titleId} className="team-options" role="radiogroup">
          {decision.options.filter((option) => option.id !== TEAM_STOP_OPTION).map((option) => (
            <OptionCard disabled={pending} key={option.id} name={`decision-${decision.id}`} onPick={setSelected} option={option} run={run} selected={selected === option.id} />
          ))}
        </div>
        {decision.kind === 'duel-winner' && <TeamDuelCandidates run={run} />}
        {needsWaiverReason && (
          <textarea
            aria-label="Waiver reason"
            className="team-waiver"
            disabled={pending}
            onChange={(event) => setWaiverReason(event.target.value)}
            placeholder="Why are you accepting the remaining risks?"
            required
            rows={3}
            value={waiverReason}
          />
        )}
        {needsExtension && <TeamLimitFields disabled={pending} draft={limits} onChange={setLimits} run={run} />}
        {sendingBack && <SendBackForm onSubmit={(note) => void decide({ ...base, note, optionId: TEAM_SEND_BACK_OPTION })} pending={pending} />}
      </div>
      <footer className="team-decision-foot">
        <span className="team-settled">
          {decision.settled.length > 0 && <>Settled so far: {decision.settled.map((item) => item.split(': ')[0]).join(', ')}</>}
        </span>
        {canSendBack && !sendingBack && (
          <button className="team-ghost" disabled={pending} onClick={() => setSendingBack(true)} type="button">Send back with a note</button>
        )}
        <button className="team-primary" data-testid="team-decision-confirm" disabled={pending || incomplete} onClick={confirm} type="button">
          {pending ? 'Saving…' : 'Confirm'}
        </button>
      </footer>
    </section>
  );
}

export function TeamDecisionCard({ decision, onClose, run }: Readonly<{ decision: TeamDecision; onClose?: () => void; run: TeamRun }>) {
  if (decision.chosen) return <ResolvedDecision decision={decision} />;
  const active = activeDecision(run);
  if (run.status !== 'waiting' || (active && active.id !== decision.id)) return null;
  return <OpenDecision decision={decision} key={decision.id} onClose={onClose} run={run} />;
}

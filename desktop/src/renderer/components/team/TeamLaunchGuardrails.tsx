import { ShieldCheck } from 'lucide-react';
import type { TeamPolicy } from '../../../shared/team-types';
import { type TeamDisclosureState, TeamLaunchDisclosure } from './TeamLaunchDisclosure';
import { invalidLimits, type TeamLimitField } from './teamLaunchModel';
import type { TeamLaunchDraft } from './useTeamLaunchDraft';

const COMPACT = new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: 'compact' });
const POLICY_NAME = 'team-launch-policy';

const LIMITS: Array<{ field: TeamLimitField; label: string; max?: number; unit: string }> = [
  { field: 'maxFixRounds', label: 'Maximum fix rounds', max: 5, unit: 'rounds' },
  { field: 'maxTokens', label: 'Token budget', unit: 'tokens' },
  { field: 'maxMinutes', label: 'Time budget in minutes', max: 1440, unit: 'min' },
];

function guardrailSummary(draft: TeamLaunchDraft, checkCommand: string): string {
  const tokens = Number(draft.maxTokens);
  return [
    draft.policy === 'every-gate' ? 'Pauses at every gate' : 'Pauses when stuck',
    `${draft.maxFixRounds} fix rounds`,
    `${Number.isFinite(tokens) ? COMPACT.format(tokens) : draft.maxTokens} tokens`,
    `${draft.maxMinutes} min`,
    checkCommand.trim() ? 'custom checks' : 'auto-detected checks',
  ].join(' · ');
}

function PolicyOption({ description, draft, onChange, title, value }: Readonly<{
  description: string; draft: TeamLaunchDraft; onChange: (draft: TeamLaunchDraft) => void; title: string; value: TeamPolicy;
}>) {
  return (
    <label>
      <input checked={draft.policy === value} name={POLICY_NAME} onChange={() => onChange({ ...draft, policy: value })} type="radio" value={value} />
      <b>{title}</b><span>{description}</span>
    </label>
  );
}

export function TeamLaunchGuardrails({ attention, checkCommand, detailsRef, draft, onChange, onCheckCommandChange, onToggle, open }: Readonly<TeamDisclosureState & {
  checkCommand: string;
  draft: TeamLaunchDraft;
  onChange: (draft: TeamLaunchDraft) => void;
  onCheckCommandChange: (command: string) => void;
}>) {
  const invalid = invalidLimits(draft);
  return (
    <TeamLaunchDisclosure
      attention={attention} detailsRef={detailsRef} icon={ShieldCheck} onToggle={onToggle} open={open}
      summary={guardrailSummary(draft, checkCommand)} testId="team-guardrails" title="Guardrails"
    >
      <section className="team-launch-section">
        <span className="team-launch-section-label">Pause for me</span>
        <div aria-label="When should the team stop for you?" className="team-policy" role="radiogroup">
          <PolicyOption description="Blockers and every merge" draft={draft} onChange={onChange} title="When stuck" value="when-stuck" />
          <PolicyOption description="Approve each stage" draft={draft} onChange={onChange} title="Every gate" value="every-gate" />
        </div>
      </section>
      <label className="team-launch-section">
        <span className="team-launch-section-label">Check command</span>
        <input aria-label="Check command" className="team-field mono" data-testid="team-check-command" onChange={(event) => onCheckCommandChange(event.target.value)} placeholder="Auto-detected if empty, for example pnpm test" value={checkCommand} />
      </label>
      <section className="team-launch-section">
        <span className="team-launch-section-label">Limits</span>
        <div className="team-launch-limits">
          {LIMITS.map(({ field, label, max, unit }) => (
            <label className="team-limit" key={field}>
              <input aria-invalid={invalid.includes(field)} aria-label={label} max={max} min={1} onChange={(event) => onChange({ ...draft, [field]: event.target.value })} step={1} type="number" value={draft[field]} />
              <span>{unit}</span>
            </label>
          ))}
        </div>
        <p className={invalid.length > 0 ? 'team-disclosure-warning' : 'team-disclosure-note'} role={invalid.length > 0 ? 'alert' : undefined}>
          {invalid.length > 0 ? 'Fix rounds must be 1 to 5, time 1 to 1440 minutes, and tokens a positive whole number.' : 'At a limit the run pauses for your decision. Tokens are observed usage, not an exact cost cap.'}
        </p>
      </section>
    </TeamLaunchDisclosure>
  );
}

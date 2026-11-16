import type { TeamRun, TeamRunLimits } from '../../../shared/team-types';

export interface TeamLimitDraft {
  minutes: string;
  tokens: string;
}

export function limitExtension(run: TeamRun, draft: TeamLimitDraft): TeamRunLimits | undefined {
  const maxTokens = Number(draft.tokens);
  const minutes = Number(draft.minutes);
  if (!run.limits || !run.limitPause?.quiesced) return undefined;
  const elapsed = Date.now() - run.createdAt;
  const maxDurationMs = Math.max(run.limits.maxDurationMs, elapsed + minutes * 60_000);
  const validNumbers = Number.isSafeInteger(maxTokens) && Number.isSafeInteger(maxDurationMs);
  const sufficient = minutes >= 0 && Number.isInteger(minutes) && maxTokens > (run.tokenUsage ?? 0) && maxDurationMs > elapsed;
  const nondecreasing = maxTokens >= run.limits.maxTokens && maxDurationMs >= run.limits.maxDurationMs;
  const increased = maxTokens > run.limits.maxTokens || maxDurationMs > run.limits.maxDurationMs;
  return validNumbers && sufficient && nondecreasing && increased ? { maxDurationMs, maxTokens } : undefined;
}

export function TeamLimitFields({ disabled, draft, onChange, run }: Readonly<{
  disabled: boolean; draft: TeamLimitDraft; onChange: (draft: TeamLimitDraft) => void; run: TeamRun;
}>) {
  return (
    <fieldset className="team-limit-fields" disabled={disabled}>
      <legend>Extend this run</legend>
      <p>The token limit is a new total cap. Additional minutes grant time from now without reducing the existing cap. Defaults are unchanged.</p>
      <label>New total token limit<input aria-label="New total token limit" className="team-field" min={run.limits?.maxTokens ?? 1} onChange={(event) => onChange({ ...draft, tokens: event.target.value })} step={1} type="number" value={draft.tokens} /></label>
      <label>Additional minutes<input aria-label="Additional minutes" className="team-field" min={0} onChange={(event) => onChange({ ...draft, minutes: event.target.value })} step={1} type="number" value={draft.minutes} /></label>
      {!run.limitPause?.quiesced && <p role="status">Waiting for writers to stop before the run can resume.</p>}
    </fieldset>
  );
}

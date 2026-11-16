import { TEAM_COUNCIL_ROLE_IDS, type TeamCouncilRoleId } from '../../../shared/team-settings';
import { useTeamAgents } from '../../hooks/useTeamAgents';
import { useElectronSettingsStore } from '../../stores/electron-settings.store';
import { TEAM_MODE_COPY, TEAM_MODE_OPTIONS } from '../team/teamModeOptions';
import { ElectronSettingRow } from './ElectronSettingRow';

const ROLE_LABELS: Record<TeamCouncilRoleId, string> = { architect: 'Architect', domain: 'Domain expert', tester: 'Tester' };

export function TeamSettings() {
  const settings = useElectronSettingsStore((s) => s.settings);
  const update = useElectronSettingsStore((s) => s.update);
  const agents = useTeamAgents();
  if (!settings) return null;
  const writerOptions = [...new Set([settings.teamWriterAgent, ...agents.all])].map((agent) => ({ label: agent, value: agent }));
  const reviewerOptions = [...new Set([settings.teamReviewerAgent, ...agents.readers])].map((agent) => ({ label: agent, value: agent }));
  const toggleRole = (role: TeamCouncilRoleId) => {
    const roles = settings.teamCouncilRoles.includes(role)
      ? settings.teamCouncilRoles.filter((item) => item !== role)
      : [...settings.teamCouncilRoles, role];
    if (roles.length > 0) void update('teamCouncilRoles', roles);
  };
  return (
    <section data-testid="team-settings">
      <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">Team defaults</h3>
      <p className="text-xs text-[var(--text-muted)] mb-4">Used to prefill new runs. Changes made in a launch form apply only to that run.</p>
      {agents.error && <p role="alert" className="text-xs text-[var(--text-muted)]">Could not load available agents: {agents.error}</p>}
      <div className="divide-y divide-[var(--border)]">
        <ElectronSettingRow settingKey="teamDefaultMode" label="Default mode" description={TEAM_MODE_COPY[settings.teamDefaultMode]} type="select" options={TEAM_MODE_OPTIONS} />
        <ElectronSettingRow settingKey="teamWriterAgent" label="Writer agent" description="Builds the change in its own worktree. Duel uses this preference for its first side." type="select" options={writerOptions} />
        <ElectronSettingRow settingKey="teamReviewerAgent" label="Reviewer agent" description="Pair uses a different agent from its writer. Duel uses a separate read-only comparator pane, which may use either writer's provider." type="select" options={reviewerOptions} />
        <ElectronSettingRow settingKey="teamPolicy" label="Human approvals" description="Every merge requires your approval, regardless of this policy." type="select" options={[{ label: 'When stuck', value: 'when-stuck' }, { label: 'Every gate', value: 'every-gate' }]} />
        <ElectronSettingRow settingKey="teamMaxFixRounds" label="Maximum fix rounds" description="Pause for your decision after this many automatic fix rounds." type="number" min={1} max={5} step={1} />
        <div className="[&_input]:w-36">
          <ElectronSettingRow settingKey="teamTokenBudget" label="Token budget" description="Pause at the observed token limit. Token reporting can lag; this is not an exact monetary cost cap." type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} />
        </div>
        <ElectronSettingRow settingKey="teamTimeLimitMinutes" label="Time limit in minutes" description="Pause when the elapsed run time reaches this limit." type="number" min={1} max={1440} step={1} />
        <fieldset className="py-3">
          <legend className="text-sm text-[var(--text)]">Council roles</legend>
          <p className="text-xs text-[var(--text-muted)] mb-2">Only used in Council mode. Choose at least one read-only role alongside the writer.</p>
          <div className="flex flex-wrap gap-4">
            {TEAM_COUNCIL_ROLE_IDS.map((role) => (
              <label className="flex items-center gap-2 text-xs text-[var(--text)]" key={role}>
                <input type="checkbox" checked={settings.teamCouncilRoles.includes(role)} disabled={settings.teamCouncilRoles.length === 1 && settings.teamCouncilRoles.includes(role)} onChange={() => toggleRole(role)} />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </section>
  );
}

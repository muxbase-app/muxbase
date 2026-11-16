import { ArrowUp } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import type { TeamStartResponse } from '../../../shared/team-types';
import { startTeamRun } from '../../api/team.api';
import { IS_MAC } from '../../lib/platform';
import { useNotificationStore, useUiStore } from '../../stores';
import { useElectronSettingsStore } from '../../stores/electron-settings.store';
import { useTeamStore } from '../../stores/team.store';
import { TeamLaunchGuardrails } from './TeamLaunchGuardrails';
import { launchBlocker, runMembers, startRequest, type TeamLaunchBlocker, type TeamLaunchSection } from './teamLaunchModel';
import { TeamLaunchTeam } from './TeamLaunchTeam';
import { TeamModePicker } from './TeamModePicker';
import { TeamSetupNotice } from './TeamSetupNotice';
import { useTeamLaunchDraft } from './useTeamLaunchDraft';
import './team-launch.css';

const START_SHORTCUT = IS_MAC ? '⌘↵' : 'Ctrl+Enter';
const SUGGESTIONS = [
  'Fix the failing tests without changing their expectations',
  'Add input validation with tests for every edge case',
  'Refactor this module for readability with no behaviour change',
];

function showStartedRun(response: TeamStartResponse, brief: string, projectRoot: string): boolean {
  const store = useTeamStore.getState();
  if (store.launchBriefs[projectRoot] === brief) store.setLaunchBrief(projectRoot, '');
  if (!response.run || (store.activeProjectRoot !== undefined && response.run.projectRoot !== store.activeProjectRoot)) return false;
  store.upsertRun(response.run);
  store.selectRun(response.run.id);
  return true;
}

function ComposerStatus({ blocker, onReveal, starting }: Readonly<{
  blocker?: TeamLaunchBlocker; onReveal: (section: TeamLaunchSection) => void; starting: boolean;
}>) {
  const section = blocker?.section;
  let content: ReactNode = blocker?.message ?? `Ready · ${START_SHORTCUT}`;
  if (starting) content = 'Starting your team…';
  else if (blocker && section) content = <button className="team-composer-reveal" onClick={() => onReveal(section)} type="button">{blocker.message}</button>;
  return <span className="team-composer-status" role="status">{content}</span>;
}

export function TeamLaunchForm({ onStarted }: Readonly<{ onStarted?: () => void }>) {
  const addToast = useNotificationStore((s) => s.addToast);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const openSettings = useUiStore((s) => s.openSettings);
  const adaptersEnabled = useElectronSettingsStore((s) => s.settings?.enableAgentLifecycleAdapters === true);
  const { catalog, draft, load, loadError, reviewer, reviewerOptions, setDraft } = useTeamLaunchDraft();
  const projectRoot = useTeamStore((s) => s.activeProjectRoot) ?? '';
  const brief = useTeamStore((s) => s.launchBriefs[projectRoot] ?? '');
  const setLaunchBrief = useTeamStore((s) => s.setLaunchBrief);
  const [checkCommand, setCheckCommand] = useState('');
  const [domain, setDomain] = useState('');
  const [starting, setStarting] = useState(false);
  const [openSections, setOpenSections] = useState<Record<TeamLaunchSection, boolean>>({ guardrails: false, team: false });
  const startingRef = useRef(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const sectionRefs = useRef<Record<TeamLaunchSection, HTMLDetailsElement | null>>({ guardrails: null, team: null });
  const members = runMembers(draft?.mode, draft?.writer, reviewer, draft?.secondWriter, draft?.rows ?? [], domain);
  const blocker = launchBlocker({ adaptersEnabled, agentsError: catalog.error, all: catalog.all, brief, draft, members, readers: catalog.readers });

  const toggleSection = (section: TeamLaunchSection, open: boolean) => setOpenSections((current) => ({ ...current, [section]: open }));
  const revealSection = (section: TeamLaunchSection) => {
    toggleSection(section, true);
    requestAnimationFrame(() => sectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const chooseSuggestion = (suggestion: string) => {
    setLaunchBrief(projectRoot, suggestion);
    briefRef.current?.focus();
  };

  const start = async () => {
    if (startingRef.current || blocker || !draft) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const response = await startTeamRun(startRequest(draft, brief, checkCommand, members));
      if (!response.success || !response.run) {
        addToast(response.error ?? 'Could not start the team', 'error');
        return;
      }
      if (!showStartedRun(response, brief, projectRoot)) return;
      setViewMode('team');
      onStarted?.();
    } catch (error) {
      addToast(`Could not start the team: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const onBriefKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void start();
  };

  return (
    <div className="team-launch" data-testid="team-launch">
      <header className="team-launch-hero">
        <h2>What should your team build?</h2>
        <p>Isolated worktrees, checks on every change, and nothing merges without you.</p>
      </header>
      {draft && !adaptersEnabled && <TeamSetupNotice />}
      <div className="team-composer-card">
        <textarea aria-label="Brief" autoFocus ref={briefRef} data-testid="team-brief" disabled={starting} onChange={(event) => setLaunchBrief(projectRoot, event.target.value)} onKeyDown={onBriefKeyDown} placeholder="Describe the outcome you want…" rows={3} value={brief} />
        <div className="team-composer-bar">
          {draft && <TeamModePicker disabled={starting} onChange={(mode) => setDraft({ ...draft, mode })} value={draft.mode} />}
          <ComposerStatus blocker={blocker} onReveal={revealSection} starting={starting} />
          <button aria-label="Start run" className="team-start" data-testid="team-start" disabled={Boolean(blocker) || starting} onClick={() => void start()} title={`Start run (${START_SHORTCUT})`} type="button">
            <ArrowUp aria-hidden="true" />
          </button>
        </div>
      </div>
      {!brief.trim() && (
        <div aria-label="Example briefs" className="team-suggestions" role="group">
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} onClick={() => chooseSuggestion(suggestion)} type="button">{suggestion}</button>
          ))}
        </div>
      )}
      {loadError && <div className="team-launch-alert" role="alert">Could not load Team defaults: {loadError} <button className="team-ghost" onClick={() => void load()} type="button">Retry</button></div>}
      {catalog.error && <div className="team-launch-alert" role="alert">Could not load available agents: {catalog.error} <button className="team-ghost" onClick={catalog.reload} type="button">Retry</button></div>}
      {!draft && !loadError && !catalog.error && <p className="team-launch-loading" role="status">Loading Team defaults and agents…</p>}
      {draft && (
        <fieldset className="team-launch-fields" disabled={starting}>
          <TeamLaunchTeam
            attention={blocker?.section === 'team'} catalog={catalog} detailsRef={(node) => { sectionRefs.current.team = node; }} domain={domain} draft={draft}
            onDomainChange={setDomain} onDraftChange={setDraft} onToggle={(open) => toggleSection('team', open)} open={openSections.team} reviewer={reviewer} reviewerOptions={reviewerOptions}
          />
          <TeamLaunchGuardrails
            attention={blocker?.section === 'guardrails'} checkCommand={checkCommand} detailsRef={(node) => { sectionRefs.current.guardrails = node; }} draft={draft}
            onChange={setDraft} onCheckCommandChange={setCheckCommand} onToggle={(open) => toggleSection('guardrails', open)} open={openSections.guardrails}
          />
        </fieldset>
      )}
      <footer className="team-launch-foot">
        <span>Settings apply to this run only.</span>
        <button className="team-link" onClick={() => openSettings('team')} type="button">Change defaults in Settings</button>
      </footer>
    </div>
  );
}

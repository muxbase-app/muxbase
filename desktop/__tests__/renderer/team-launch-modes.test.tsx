// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronSettingsService } from '../../src/main/services/ElectronSettingsService';
import { TeamLaunchForm } from '../../src/renderer/components/team/TeamLaunchForm';
import { TeamDecisionCard } from '../../src/renderer/components/team/TeamDecisionCard';
import { TeamDuelCandidates } from '../../src/renderer/components/team/TeamDuelCandidates';
import { TeamFinalCard } from '../../src/renderer/components/team/TeamFinalCard';
import { limitExtension } from '../../src/renderer/components/team/TeamLimitFields';
import { gateViews, roleName } from '../../src/renderer/components/team/teamViewModel';
import { useElectronSettingsStore } from '../../src/renderer/stores/electron-settings.store';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { useTeamStore } from '../../src/renderer/stores/team.store';
import { useUiStore } from '../../src/renderer/stores/ui.store';
import { IPC } from '../../src/shared/ipc-channels';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import { deferred, teamRun } from './team-test-support';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('../../src/renderer/api/ipc', () => ({ invoke: ipc.invoke, on: ipc.on }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({
      animate: _animate,
      children,
      exit: _exit,
      initial: _initial,
      transition: _transition,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & Record<'animate' | 'exit' | 'initial' | 'transition', unknown>) => (
      <div {...props}>{children}</div>
    ),
    span: ({ layoutId: _layoutId, transition: _transition, ...props }: React.HTMLAttributes<HTMLSpanElement> & Record<'layoutId' | 'transition', unknown>) => <span {...props} />,
  },
}));
vi.mock('../../src/renderer/components/pane-detail/LazyGitDiffView', () => ({
  LazyGitDiffView: ({ pane }: { pane: { id: string } }) => <div>Diff for {pane.id}</div>,
}));

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

function enabledTeamDefaults() {
  return { ...ElectronSettingsService.getDefaults(), enableAgentLifecycleAdapters: true };
}

describe('Team per-run mode preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useElectronSettingsStore.setState({ settings: enabledTeamDefaults(), isLoading: false, loadError: null });
    useTeamStore.setState({ activeProjectRoot: '/project/a', activeRunId: null, launchBriefs: {}, launchOpen: false, runs: [] });
    ipc.invoke.mockImplementation(async (channel: string) => channel === IPC.AGENT_LIST
      ? ['claude', 'codex', 'opencode'] : { error: 'Not launched in this test', success: false });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('enables lifecycle adapters in one click without leaving the launch form or discarding the brief', async () => {
    // Arrange
    const disabled = { ...ElectronSettingsService.getDefaults(), enableAgentLifecycleAdapters: false };
    useElectronSettingsStore.setState({ settings: disabled });
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.AGENT_LIST) return ['claude', 'codex', 'opencode'];
      if (channel === IPC.ELECTRON_SETTINGS_UPDATE) return enabledTeamDefaults();
      return { error: 'Not launched in this test', success: false };
    });
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Keep my planned work' } });
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Finish the one-time setup above')).toBeTruthy();

    // Act
    fireEvent.click(within(screen.getByRole('region', { name: 'Team setup' })).getByRole('button', { name: 'Enable' }));
    await flush();
    await flush();

    // Assert
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.ELECTRON_SETTINGS_UPDATE, { key: 'enableAgentLifecycleAdapters', value: true });
    expect(screen.queryByRole('region', { name: 'Team setup' })).toBeNull();
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(false);
    expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('Keep my planned work');
    expect(useUiStore.getState().activeView).not.toBe('settings');
  });

  it('explains why Start is unavailable and starts from the keyboard once ready', async () => {
    // Arrange
    render(<TeamLaunchForm />);
    await flush();
    expect(screen.getByText('Describe the outcome to start')).toBeTruthy();

    // Act
    const brief = screen.getByRole('textbox', { name: 'Brief' });
    fireEvent.change(brief, { target: { value: 'Ship the fix' } });
    fireEvent.keyDown(brief, { key: 'Enter', metaKey: true });
    await flush();

    // Assert
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({ brief: 'Ship the fix', mode: 'pair' }));
  });

  it('retains the brief when navigating to Settings and returning to the launch form', async () => {
    const first = render(<TeamLaunchForm />);
    await flush();
    const brief = 'Keep this planned compatibility fix while changing defaults.';
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: brief } });
    fireEvent.click(screen.getByRole('button', { name: 'Change defaults in Settings' }));
    first.unmount();
    render(<TeamLaunchForm />);
    await flush();

    expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe(brief);
    expect(ipc.invoke.mock.calls.some(([channel]) => channel === IPC.ELECTRON_SETTINGS_UPDATE)).toBe(false);
  });

  it('keeps separate briefs when switching projects without remounting the form', async () => {
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Project A work' } });
    act(() => useTeamStore.getState().setActiveProjectRoot('/project/b'));

    expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Project B work' } });
    act(() => useTeamStore.getState().setActiveProjectRoot('/project/a'));
    expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('Project A work');
    act(() => useTeamStore.getState().setActiveProjectRoot('/project/b'));
    expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('Project B work');
  });

  it.each([false, true])('clears the submitted brief only after a successful launch: %s', async (success) => {
    ipc.invoke.mockImplementation(async (channel: string) => channel === IPC.AGENT_LIST
      ? ['claude', 'codex'] : { error: 'Launch failed', run: success ? teamRun() : undefined, success });
    const first = render(<TeamLaunchForm />);
    await flush();
    const brief = 'Launch this once';
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: brief } });
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    first.unmount();
    render(<TeamLaunchForm />);
    await flush();

    expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe(success ? '' : brief);
  });

  it('does not erase a replacement brief when an earlier launch completes after navigation', async () => {
    const response = deferred<{ run: ReturnType<typeof teamRun>; success: true }>();
    ipc.invoke.mockImplementation(async (channel: string) => channel === IPC.TEAM_START
      ? response.promise : channel === IPC.AGENT_LIST ? ['claude', 'codex'] : undefined);
    const first = render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Submitted work' } });
    fireEvent.click(screen.getByTestId('team-start'));
    first.unmount();
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'New work after navigation' } });

    await act(async () => response.resolve({ run: teamRun(), success: true }));

    expect((screen.getByRole('textbox', { name: 'Brief' }) as HTMLTextAreaElement).value).toBe('New work after navigation');
  });

  it('launches Pair with an independent reviewer and keeps per-run edits out of defaults', async () => {
    render(<TeamLaunchForm />);
    await flush();
    expect(screen.getByTestId('team-mode-pair').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Remove Architect' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build a small fix' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum fix rounds' }), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({
      maxFixRounds: 4, members: [{ agent: 'codex', role: 'developer' }, { agent: 'claude', role: 'tester' }], mode: 'pair',
    }));
    expect(useElectronSettingsStore.getState().settings?.teamMaxFixRounds).toBe(2);
    expect(ipc.invoke.mock.calls.some(([channel]) => channel === IPC.ELECTRON_SETTINGS_UPDATE)).toBe(false);
  });

  it('prefills once after settings load without replacing later local edits', async () => {
    const settings = deferred<ElectronSettings>();
    useElectronSettingsStore.setState({ settings: null });
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.ELECTRON_SETTINGS_GET) return settings.promise;
      if (channel === IPC.AGENT_LIST) return ['claude', 'codex', 'opencode'];
      return { error: 'Not launched in this test', success: false };
    });
    render(<TeamLaunchForm />);
    settings.resolve({ ...enabledTeamDefaults(), teamDefaultMode: 'council', teamMaxFixRounds: 3 });
    await flush();
    fireEvent.click(screen.getByTestId('team-mode-duel'));
    act(() => useElectronSettingsStore.setState({ settings: { ...enabledTeamDefaults(), teamDefaultMode: 'pair' } }));
    expect(screen.getByTestId('team-mode-duel').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Remove Architect' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Compare implementations' } });
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({
      duelSides: [{ agent: 'codex' }, { agent: 'claude' }], maxFixRounds: 3, mode: 'duel',
    }));
  });

  it('selects another available reviewer when a stored preference matches the writer', async () => {
    useElectronSettingsStore.setState({ settings: { ...enabledTeamDefaults(), teamReviewerAgent: 'codex' } });
    render(<TeamLaunchForm />);
    await flush();
    expect((screen.getByRole('combobox', { name: 'Reviewer' }) as HTMLSelectElement).value).toBe('claude');
    expect(within(screen.getByRole('combobox', { name: 'Reviewer' })).queryByRole('option', { name: 'Codex' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change defaults in Settings' }));
    expect(useUiStore.getState()).toMatchObject({ activeView: 'settings', settingsCategory: 'team' });
  });

  it('blocks Pair and Duel without enough independent review agents', async () => {
    ipc.invoke.mockResolvedValue(['codex']);
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build it' } });
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('saved reviewer Claude Code is not available');
    expect(useElectronSettingsStore.getState().settings?.teamReviewerAgent).toBe('claude');
  });

  it('shows only Council roles selected in defaults and requires a reviewer', async () => {
    useElectronSettingsStore.setState({ settings: {
      ...enabledTeamDefaults(), teamCouncilRoles: ['domain'], teamDefaultMode: 'council',
    } });
    render(<TeamLaunchForm />);
    await flush();
    expect(screen.getByRole('button', { name: 'Add Architect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Domain expert' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Domain expert' }));
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(true);
  });

  it('shows both Duel snapshots and the human-selected writer without claiming comparison is approval', () => {
    const run = teamRun({ mode: 'duel', selectedSourceId: 'writer-b', stage: 'review', members: [
      { agent: 'codex', label: 'Candidate A', paneId: 'writer-a', readOnly: false, role: 'developer', worktreePath: '/project/a' },
      { agent: 'claude', label: 'Candidate B', paneId: 'writer-b', readOnly: false, role: 'architect', worktreePath: '/project/b' },
    ], duelSnapshots: {
      developer: { checksPassed: true, paneId: 'writer-a', snapshotSha: 'aaaaaaa' },
      architect: { checksPassed: false, paneId: 'writer-b', snapshotSha: 'bbbbbbb' },
    } });
    render(<TeamDuelCandidates run={run} />);
    expect(screen.getByTestId('team-duel-writer-a').textContent).toContain('aaaaaaa');
    expect(screen.getByTestId('team-duel-writer-b').textContent).toContain('Chosen by you');
    expect(screen.getByText(/Review and checks still gate your merge/)).toBeTruthy();
    usePaneStore.setState({ panes: [{ id: 'writer-b', paneId: '%2', prompt: 'Build', slug: 'writer-b', worktreePath: '/project/b' }] });
    render(<TeamFinalCard run={{ ...run, status: 'ready' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'View changes' }));
    expect(screen.getByRole('dialog', { name: 'Review writer changes' })).toBeTruthy();
    expect(screen.getByText('Diff for writer-b')).toBeTruthy();
    expect(gateViews(teamRun({ mode: 'pair', stage: 'build' })).map((gate) => gate.id)).not.toContain('design');
    expect(gateViews(run).find((gate) => gate.id === 'choose')?.state).toBe('done');
    expect(roleName(run, 'architect')).toBe('Writer B');
  });

  it('requires an explicit larger total cap and a quiesced run before extending a pause', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const run = teamRun({
      createdAt: Date.now() - 60_000,
      limitPause: { at: Date.now(), quiesced: true, reason: 'Token limit reached', resumeStep: 'build' },
      limits: { maxDurationMs: 3_600_000, maxTokens: 100 },
      status: 'waiting', tokenUsage: 100,
    });
    render(<TeamDecisionCard decision={{
      id: 'limit', kind: 'limit', label: 'Run limit', openedAt: Date.now(),
      options: [{ holders: [], id: 'extend', title: 'Extend limits' }], settled: [], title: 'Paused at the limit', why: 'Observed token cap reached',
    }} run={run} />);
    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Extend limits' }));
    expect((screen.getByRole('spinbutton', { name: 'New total token limit' }) as HTMLInputElement).value).toBe('1000100');
    expect(ipc.invoke.mock.calls.some(([channel]) => channel === IPC.TEAM_DECIDE)).toBe(false);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'New total token limit' }), { target: { value: '100' } });
    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'New total token limit' }), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('team-decision-confirm'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_DECIDE, expect.objectContaining({ extension: { maxDurationMs: 3_660_000, maxTokens: 200 }, optionId: 'extend' }));
    expect(useElectronSettingsStore.getState().settings?.teamTokenBudget).toBe(1_000_000);
    expect(limitExtension({ ...run, limitPause: { ...run.limitPause!, quiesced: false } }, { minutes: '60', tokens: '200' })).toBeUndefined();
    expect(limitExtension(run, { minutes: '-1', tokens: '200' })).toBeUndefined();
    expect(limitExtension(run, { minutes: '0', tokens: '200' })).toEqual({ maxDurationMs: 3_600_000, maxTokens: 200 });
    const overnight = { ...run, createdAt: now - 172_800_000 };
    expect(limitExtension(overnight, { minutes: '60', tokens: '200' })).toEqual({ maxDurationMs: 176_400_000, maxTokens: 200 });
  });

  it('returns to the earlier question after a limit pause is extended', () => {
    const earlier = { id: 'earlier', kind: 'approval' as const, label: 'Approval', openedAt: 1, options: [{ holders: [], id: 'fix', title: 'Fix issues' }], settled: [], title: 'Review question', why: 'Issues remain' };
    const pause = { id: 'limit', kind: 'limit' as const, label: 'Limit', openedAt: 2, options: [{ holders: [], id: 'extend', title: 'Extend limits' }], settled: [], title: 'Limit question', why: 'Cap reached' };
    const run = teamRun({ decisions: [earlier, pause], status: 'waiting' });
    const view = render(<><TeamDecisionCard decision={earlier} run={run} /><TeamDecisionCard decision={pause} run={run} /></>);
    expect(screen.queryByText('Review question')).toBeNull();
    expect(screen.getByText('Limit question')).toBeTruthy();
    const resumed = { ...run, decisions: [earlier, { ...pause, chosen: 'extend' }] };
    view.rerender(<><TeamDecisionCard decision={earlier} run={resumed} /><TeamDecisionCard decision={resumed.decisions[1]} run={resumed} /></>);
    expect(screen.getByText('Review question')).toBeTruthy();
    expect(screen.queryByText('Limit question')).toBeNull();
  });

  it('reuses native side tuning for two Codex writers with an independent Claude comparator', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.AGENT_LIST) return ['claude', 'codex'];
      if (channel === IPC.AGENT_DEFAULTS_GET) return {};
      return { error: 'Not launched in this test', success: false };
    });
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.click(screen.getByTestId('team-mode-duel'));
    await flush();
    fireEvent.change(screen.getByRole('combobox', { name: 'Writer B' }), { target: { value: 'codex' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Compare two attempts' } });
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(screen.getByTestId('team-writer-a')).getByRole('button', { name: 'Effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'High' }));
    fireEvent.click(within(screen.getByTestId('team-writer-b')).getByRole('button', { name: 'Effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({
      duelSides: [{ agent: 'codex', effort: 'high' }, { agent: 'codex', effort: 'low' }],
      members: [{ agent: 'codex', role: 'developer' }, { agent: 'codex', role: 'architect' }, { agent: 'claude', role: 'tester' }],
    }));
  });

  it('launches the default Claude/Codex Duel with a separate comparator using either installed provider', async () => {
    useElectronSettingsStore.setState({ settings: { ...enabledTeamDefaults(), teamDefaultMode: 'duel' } });
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.AGENT_LIST) return ['claude', 'codex'];
      if (channel === IPC.AGENT_DEFAULTS_GET) return {};
      return { error: 'Not launched in this test', success: false };
    });
    render(<TeamLaunchForm />);
    await flush();
    const comparator = screen.getByRole('combobox', { name: 'Comparator' }) as HTMLSelectElement;
    expect(comparator.value).toBe('claude');
    expect(within(comparator).getByRole('option', { name: 'Codex' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Compare both implementations' } });
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({
      duelSides: [{ agent: 'codex' }, { agent: 'claude' }],
      members: [{ agent: 'codex', role: 'developer' }, { agent: 'claude', role: 'architect' }, { agent: 'claude', role: 'tester' }],
      mode: 'duel',
    }));
    fireEvent.change(comparator, { target: { value: 'codex' } });
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({
      members: [{ agent: 'codex', role: 'developer' }, { agent: 'claude', role: 'architect' }, { agent: 'codex', role: 'tester' }],
      mode: 'duel',
    }));
    expect(useElectronSettingsStore.getState().settings?.teamReviewerAgent).toBe('claude');
  });

  it('keeps Duel winner selection explicit rather than preselecting the comparator recommendation', async () => {
    const run = teamRun({ mode: 'duel', status: 'waiting' });
    render(<TeamDecisionCard decision={{
      id: 'winner', kind: 'duel-winner', label: 'Your winner', openedAt: 1,
      options: [{ holders: ['developer'], id: 'writer-a', title: 'Writer A' }, { holders: ['architect'], id: 'writer-b', title: 'Writer B' }],
      settled: [], title: 'Choose the writer', why: 'The comparator recommends A. You decide.',
    }} run={run} />);
    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Writer B' }));
    fireEvent.click(screen.getByTestId('team-decision-confirm'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_DECIDE, expect.objectContaining({ optionId: 'writer-b' }));
    expect(run.selectedSourceId).toBeUndefined();
  });

  it('refuses to merge an unselected Duel pane returned by preparation', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => channel === IPC.TEAM_PREPARE_MERGE
      ? { paneId: 'writer-a', success: true } : { message: 'Merged', type: 'success' });
    render(<TeamFinalCard run={teamRun({ mode: 'duel', selectedSourceId: 'writer-b', status: 'ready' })} />);
    fireEvent.click(screen.getByTestId('team-merge'));
    await flush();
    expect(ipc.invoke.mock.calls.map(([channel]) => channel)).toEqual([IPC.TEAM_PREPARE_MERGE]);
  });
});

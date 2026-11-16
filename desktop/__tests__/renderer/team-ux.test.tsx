// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronSettingsService } from '../../src/main/services/ElectronSettingsService';
import { TeamChannel } from '../../src/renderer/components/team/TeamChannel';
import { TeamFeedEntry } from '../../src/renderer/components/team/TeamFeed';
import { TeamRoomView } from '../../src/renderer/components/team/TeamRoomView';
import { useElectronSettingsStore } from '../../src/renderer/stores/electron-settings.store';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { useNotificationStore } from '../../src/renderer/stores/notification.store';
import { isTeamReadyVisible, isTeamToastVisible, useTeamStore } from '../../src/renderer/stores/team.store';
import { useUiStore } from '../../src/renderer/stores/ui.store';
import type { TeamDecision } from '../../src/shared/team-types';
import { teamRun } from './team-test-support';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('../../src/renderer/api/ipc', () => ({ invoke: ipc.invoke, on: ipc.on }));
vi.mock('../../src/renderer/components/pane-detail/LazyGitDiffView', () => ({
  LazyGitDiffView: ({ pane }: { pane: { id: string } }) => <div>Diff for {pane.id}</div>,
}));
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

const decision: TeamDecision = {
  id: 'decision-a', kind: 'approval', label: 'D-1', openedAt: 1,
  options: [{ holders: [], id: 'fix', title: 'Fix the issue' }],
  settled: [], title: 'Review found an issue', why: 'The check did not pass.',
};

beforeEach(() => {
  vi.clearAllMocks();
  ipc.invoke.mockResolvedValue({ success: true });
  useElectronSettingsStore.setState({ settings: ElectronSettingsService.getDefaults(), isLoading: false, loadError: null });
  usePaneStore.setState({ panes: [] });
  useTeamStore.setState({ activeRunId: null, autoOpenedDecisionIds: [], launchBriefs: {}, launchOpen: false, runs: [] });
  useNotificationStore.setState({ toasts: [] });
  useUiStore.setState({ activeView: 'dashboard', viewMode: 'team' });
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(cleanup);

describe('Team interaction clarity', () => {
  it.each([
    ['pair', [['developer', 'WR'], ['tester', 'RV']]],
    ['duel', [['developer', 'WA'], ['architect', 'WB'], ['tester', 'CM']]],
    ['council', [['developer', 'DV'], ['architect', 'AR'], ['domain', 'DX'], ['tester', 'TS']]],
  ] as const)('uses consistent %s marks in run context, message avatars, and decision backers', (mode, marks) => {
    const run = teamRun({
      decisions: [{ ...decision, options: [{ holders: marks.map(([role]) => role), id: 'fix', title: 'Fix the issue' }] }],
      feed: marks.map(([role], index) => ({
        at: index, evidence: [], id: `message-${role}`, kind: 'message' as const, label: 'Reports', reply: false, role, text: `Report from ${role}`,
      })),
      members: marks.map(([role]) => ({
        agent: 'codex' as const, paneId: role, readOnly: role === 'tester' || role === 'domain', role, worktreePath: '/project/writer',
      })),
      mode,
      status: 'waiting',
    });
    useTeamStore.setState({ activeRunId: run.id, runs: [run] });
    const { container } = render(<TeamRoomView />);
    fireEvent.click(screen.getByRole('button', { name: 'Run context', exact: true }));
    const expected = marks.map(([, mark]) => mark);
    const contents = (selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent?.trim());

    expect(contents('.team-crew')).toEqual(expected);
    expect(contents('.team-avatar')).toEqual(expected);
    expect(contents('.team-backers i')).toEqual(expected);
  });

  it('keeps run context available from a keyboard-operable dialog when the rail is hidden', async () => {
    const run = teamRun({
      brief: 'Preserve this full brief when inspecting the narrow layout.',
      dissent: [{ at: 1, decisionLabel: 'D-1', role: 'tester', text: 'Keep the compatibility concern visible' }],
      mode: 'pair',
      members: [
        { agent: 'codex', paneId: 'writer-a', readOnly: false, role: 'developer', worktreePath: '/project/writer' },
        { agent: 'claude', paneId: 'reviewer-a', readOnly: true, role: 'tester', worktreePath: '/project/writer' },
      ],
    });
    useTeamStore.setState({ activeRunId: run.id, runs: [run] });
    render(<TeamRoomView />);
    const trigger = screen.getByRole('button', { name: 'Run context', exact: true });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Run context' });

    expect(within(dialog).getByText(run.brief)).toBeTruthy();
    expect(within(dialog).getByText('Writer')).toBeTruthy();
    expect(within(dialog).getByText('Reviewer')).toBeTruthy();
    expect(within(dialog).getByText(run.dissent[0].text)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close run context' })));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('announces run status changes without making the whole header a live region', () => {
    const run = teamRun({ mode: 'pair' });
    useTeamStore.setState({ activeRunId: run.id, runs: [run] });
    render(<TeamRoomView />);
    const status = screen.getByRole('status', { name: 'Run status' });

    expect(status.textContent).toBe('Working');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    act(() => useTeamStore.setState({ runs: [{ ...run, status: 'ready' }] }));
    expect(status.textContent).toBe('Ready to merge');
    expect(status.querySelector('button')).toBeNull();
  });

  it.each([
    ['ready', 'Ready for your review. Inspect changes, then merge when ready.'],
    ['stopped', 'Stopped. Writer work is preserved.'],
    ['failed', 'Notes are paused. This run ended with an error.'],
  ] as const)('replaces the closed %s composer with one readable hint', (status, hint) => {
    render(<TeamChannel run={teamRun({ status })} />);

    expect(screen.queryByRole('textbox', { name: 'Message the team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send note' })).toBeNull();
    expect(screen.getAllByText(hint)).toHaveLength(1);
  });

  it('labels unavailable usage log freshness honestly', () => {
    const run = teamRun({ mode: 'pair', tokenUsage: 100 });
    useTeamStore.setState({ activeProjectRoot: run.projectRoot, activeRunId: run.id, runs: [run] });

    render(<TeamRoomView />);
    fireEvent.click(screen.getByRole('button', { name: 'Run context', exact: true }));

    expect(screen.getByText(/logs unknown/)).toBeTruthy();
  });

  it('shows the actual source timestamp without presenting it as a hard spending cap', () => {
    const timestamp = 1_700_000_000_000;
    const run = teamRun({ mode: 'pair', tokenUsage: 100, usageSourceUpdatedAt: timestamp });
    useTeamStore.setState({ activeProjectRoot: run.projectRoot, activeRunId: run.id, runs: [run] });

    render(<TeamRoomView />);
    fireEvent.click(screen.getByRole('button', { name: 'Run context', exact: true }));

    const source = screen.getByTitle(/^Most recent agent log update:/);
    expect(source.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(timestamp).toISOString());
    expect(source.title).toContain('Token reports can still lag');
  });

  it('dismisses an earlier ready notice when its pinned result becomes visible without hiding other runs or errors', () => {
    const run = teamRun({ mode: 'pair', status: 'ready' });
    const identity = { projectRoot: run.projectRoot, runId: run.id };
    useTeamStore.setState({ activeProjectRoot: run.projectRoot, activeRunId: run.id, runs: [run] });
    const notifications = useNotificationStore.getState();
    notifications.addToast('Current run ready', 'success', { teamReady: identity });
    notifications.addToast('Other run ready', 'success', { teamReady: { ...identity, runId: 'other-run' } });
    notifications.addToast('Keep this error', 'error', { teamReady: identity });

    render(<TeamRoomView />);

    expect(useNotificationStore.getState().toasts.map((toast) => toast.message)).toEqual(['Other run ready', 'Keep this error']);
  });

  it('dismisses only the matching visible decision warning, preserving other projects, runs, errors, and untagged warnings', () => {
    const run = teamRun({ decisions: [decision], mode: 'pair', status: 'waiting' });
    const identity = { projectRoot: run.projectRoot, runId: run.id };
    useTeamStore.setState({ activeProjectRoot: run.projectRoot, activeRunId: run.id, runs: [run] });
    const notifications = useNotificationStore.getState();
    notifications.addToast('Current decision', 'warning', { teamReady: identity });
    notifications.addToast('Other run decision', 'warning', { teamReady: { ...identity, runId: 'other-run' } });
    notifications.addToast('Other project decision', 'warning', { teamReady: { ...identity, projectRoot: '/other-project' } });
    notifications.addToast('Keep this error', 'error', { teamReady: identity });
    notifications.addToast('Keep this untagged warning', 'warning');

    render(<TeamRoomView />);

    expect(useNotificationStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Other run decision', 'Other project decision', 'Keep this error', 'Keep this untagged warning',
    ]);
  });

  it('retains decision warnings away from the matching visible gate, including while launching another run', () => {
    const run = teamRun({ decisions: [decision], mode: 'pair', status: 'waiting' });
    useTeamStore.setState({ activeProjectRoot: run.projectRoot, activeRunId: run.id, runs: [run] });
    const toast = { severity: 'warning' as const, teamReady: { projectRoot: run.projectRoot, runId: run.id } };

    expect(isTeamToastVisible(toast, 'dashboard', 'team')).toBe(true);
    expect(isTeamToastVisible(toast, 'settings', 'team')).toBe(false);
    expect(isTeamToastVisible(toast, 'dashboard', 'fleet')).toBe(false);
    useTeamStore.setState({ launchOpen: true });
    expect(isTeamToastVisible(toast, 'dashboard', 'team')).toBe(false);
    useTeamStore.setState({ launchOpen: false, runs: [{ ...run, decisions: [{ ...decision, chosen: 'fix' }] }] });
    expect(isTeamToastVisible(toast, 'dashboard', 'team')).toBe(false);
    useTeamStore.setState({ runs: [{ ...run, status: 'running' }] });
    expect(isTeamToastVisible(toast, 'dashboard', 'team')).toBe(false);
  });

  it('suppresses only the already-visible run completion notice, keeping other run and project notices', () => {
    const run = teamRun({ mode: 'pair', status: 'ready' });
    useTeamStore.setState({ activeProjectRoot: run.projectRoot, activeRunId: run.id, runs: [run] });
    const ready = { projectRoot: run.projectRoot, runId: run.id };

    expect(isTeamReadyVisible(ready, 'dashboard', 'team')).toBe(true);
    expect(isTeamReadyVisible(ready, 'settings', 'team')).toBe(false);
    expect(isTeamReadyVisible(ready, 'dashboard', 'fleet')).toBe(false);
    expect(isTeamReadyVisible({ ...ready, runId: 'another-run' }, 'dashboard', 'team')).toBe(false);
    expect(isTeamReadyVisible({ ...ready, projectRoot: '/another-project' }, 'dashboard', 'team')).toBe(false);
    useTeamStore.setState({ launchOpen: true });
    expect(isTeamReadyVisible(ready, 'dashboard', 'team')).toBe(false);
  });

  it('labels historical work as build activity rather than current working agents', () => {
    render(<TeamChannel run={teamRun({
      status: 'ready',
      feed: [{ at: 1, id: 'old-build', kind: 'lead', lane: 'working', text: 'Build started earlier' }],
    })} />);

    expect(screen.getByRole('tab', { name: 'Build activity 1' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Working 1' })).toBeNull();
  });

  it('docks the pending human gate below the timeline and keeps it visible through every filter', () => {
    const run = teamRun({
      decisions: [decision], status: 'waiting',
      feed: [{ at: 1, decisionId: decision.id, id: 'decision-event', kind: 'decision', lane: 'contested' }],
    });
    render(<TeamChannel run={run} />);
    fireEvent.click(screen.getByTestId('team-filter-agreed'));

    const action = screen.getByTestId('team-next-action');
    expect(within(action).getByRole('heading', { name: decision.title })).toBeTruthy();
    expect(screen.getByRole('tabpanel').compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('team-decision')).toHaveLength(1);
  });

  it('lets keyboard users scroll long pinned errors and decision details without choosing an option', () => {
    const longDecision = { ...decision, why: 'Review detail '.repeat(400) };
    render(<TeamChannel run={teamRun({
      decisions: [longDecision],
      error: 'The external check did not complete. '.repeat(400),
      status: 'waiting',
    })} />);

    expect(screen.getByRole('region', { name: 'Error details' }).tabIndex).toBe(0);
    expect(screen.getByRole('region', { name: 'Decision details' }).tabIndex).toBe(0);
    expect(screen.getByTestId('team-recovery').textContent).toContain('The external check did not complete.');
    expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
  });

  it('moves focus to the composer when a confirmed decision closes its dock', async () => {
    const run = teamRun({ decisions: [decision], status: 'waiting' });
    useTeamStore.setState({ activeProjectRoot: run.projectRoot, activeRunId: run.id, runs: [run] });
    render(<TeamRoomView />);
    fireEvent.click(screen.getByRole('radio', { name: 'Fix the issue' }));
    screen.getByTestId('team-decision-confirm').focus();
    fireEvent.click(screen.getByTestId('team-decision-confirm'));
    await act(async () => { await Promise.resolve(); });
    act(() => useTeamStore.setState({ runs: [{ ...run, decisions: [{ ...decision, chosen: 'fix' }], status: 'running' }] }));

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message the team' }));
  });

  it('shows a recovered ready run action without relying on a final feed event', () => {
    render(<TeamChannel run={teamRun({ status: 'ready' })} />);

    expect(within(screen.getByTestId('team-next-action')).getByTestId('team-merge')).toBeTruthy();
    expect(screen.getAllByTestId('team-final')).toHaveLength(1);
    expect(screen.getByText('Ready for your review. Inspect changes, then merge when ready.')).toBeTruthy();
  });

  it('uses one tab stop and supports arrow, Home and End navigation with linked panels', () => {
    render(<TeamChannel run={teamRun()} />);
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[1].id);
    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(document.activeElement).toBe(tabs.at(-1));
    fireEvent.keyDown(tabs.at(-1)!, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('provides an explicit send action and a meaningful empty filter state', () => {
    render(<TeamChannel run={teamRun()} />);

    expect(screen.getByRole('button', { name: 'Send note' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the team' }), { target: { value: 'Keep the API stable' } });
    expect(screen.getByRole('button', { name: 'Send note' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByTestId('team-filter-contested'));
    expect(screen.getByText(/No .* yet/i)).toBeTruthy();
  });

  it('does not spend the Pair overview on empty lanes or a decorative alignment graph', () => {
    const run = teamRun({ mode: 'pair', status: 'ready' });
    useTeamStore.setState({ activeRunId: run.id, runs: [run] });
    render(<TeamRoomView />);
    fireEvent.click(screen.getByRole('button', { name: 'Run context', exact: true }));

    expect(screen.queryByText('Alignment')).toBeNull();
    expect(screen.queryByText('Nothing yet')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Run context' })).toBeTruthy();
  });

  it('opens the selected writer diff in place and restores keyboard focus when dismissed', async () => {
    const run = teamRun({
      mode: 'duel', selectedSourceId: 'writer-b', status: 'ready',
      members: [{ agent: 'claude', label: 'Candidate B', paneId: 'writer-b', readOnly: false, role: 'architect', worktreePath: '/project/b' }],
    });
    usePaneStore.setState({ panes: [{ id: 'writer-b', paneId: '%2', prompt: 'Build', slug: 'writer-b', worktreePath: '/project/b' }] });
    render(<TeamChannel run={run} />);
    const trigger = screen.getByRole('button', { name: 'View changes' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Review writer changes' });
    expect(screen.getByText('Diff for writer-b')).toBeTruthy();
    expect(useUiStore.getState().viewMode).toBe('team');
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close diff' })));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('makes check output inspectable instead of displaying only a success badge', () => {
    const item = { at: 1, command: 'pnpm test', id: 'check-a', kind: 'check' as const, output: 'PASS · 3 tests', passed: true };
    const { container } = render(<TeamFeedEntry item={item} run={teamRun()} />);

    expect(container.querySelector('details')).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toContain(item.output);
    expect(container.querySelector('pre')?.textContent).toContain(item.command);
    expect(screen.getByRole('region', { name: 'Check output: pnpm test' }).tabIndex).toBe(0);
    expect(container.querySelector('summary')?.textContent).toContain('pnpm test');
  });
});

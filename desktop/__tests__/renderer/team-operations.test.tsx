// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronSettingsService } from '../../src/main/services/ElectronSettingsService';
import { TeamDecisionCard } from '../../src/renderer/components/team/TeamDecisionCard';
import { TeamFinalCard } from '../../src/renderer/components/team/TeamFinalCard';
import { TeamLaunchForm } from '../../src/renderer/components/team/TeamLaunchForm';
import { TeamRoomView } from '../../src/renderer/components/team/TeamRoomView';
import { TeamSealedRound } from '../../src/renderer/components/team/TeamSealedRound';
import { canStopRun, isRunLive } from '../../src/renderer/components/team/teamViewModel';
import { useNotificationStore } from '../../src/renderer/stores/notification.store';
import { useElectronSettingsStore } from '../../src/renderer/stores/electron-settings.store';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { useTeamStore } from '../../src/renderer/stores/team.store';
import { IPC } from '../../src/shared/ipc-channels';
import type { SerializableActionResult } from '../../src/shared/ipc-types';
import type { TeamActionResponse, TeamDecision, TeamStartResponse } from '../../src/shared/team-types';
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

const decision: TeamDecision = {
  id: 'decision-a',
  kind: 'approval',
  label: 'Approval',
  openedAt: 1,
  options: [
    { holders: [], id: 'accept', title: 'Accept as-is' },
    { holders: [], id: 'fix', title: 'Fix the issues' },
  ],
  settled: [],
  title: 'Accept the blocked snapshot?',
  why: 'The review still has blocking issues.',
};

function toastError(message: string) {
  expect(useNotificationStore.getState().toasts).toContainEqual(expect.objectContaining({ message: expect.stringContaining(message), severity: 'error' }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe('Team operation safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.getState().clearToasts();
    useElectronSettingsStore.setState({ settings: { ...ElectronSettingsService.getDefaults(), enableAgentLifecycleAdapters: true }, isLoading: false, loadError: null });
    usePaneStore.setState({ panes: [] });
    useTeamStore.setState({ activeProjectRoot: undefined, activeRunId: null, launchBriefs: {}, launchOpen: false, runs: [] });
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.AGENT_LIST) return ['claude', 'codex'];
      if (channel === IPC.TEAM_PREPARE_MERGE) return { paneId: 'developer', success: true };
      if (channel === IPC.PANE_MERGE) return { message: 'Merged', type: 'success' };
      return { success: true };
    });
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(cleanup);

  it('requires an explicit selection and a reason before accepting a waiver', async () => {
    render(<TeamDecisionCard decision={decision} run={teamRun({ status: 'waiting' })} />);
    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Accept as-is' }));

    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(true);
    const input = screen.getByRole('textbox', { name: 'Waiver reason' });
    const reason = `Risk accepted for the internal prototype.\nFollow up ${'compatibility-'.repeat(30)}review.`;
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.getAttribute('rows')).toBe('3');
    fireEvent.change(input, { target: { value: reason } });
    expect((input as HTMLTextAreaElement).value).toBe(reason);
    fireEvent.click(screen.getByTestId('team-decision-confirm'));
    await flush();

    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_DECIDE, expect.objectContaining({ note: reason, optionId: 'accept' }));
  });

  it('blocks duplicate decisions and resets pending after rejection with a visible error', async () => {
    const response = deferred<TeamActionResponse>();
    ipc.invoke.mockReturnValue(response.promise);
    render(<TeamDecisionCard decision={decision} run={teamRun({ status: 'waiting' })} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Fix the issues' }));
    fireEvent.click(screen.getByTestId('team-decision-confirm'));

    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('team-decision-confirm'));
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    await act(async () => response.reject(new Error('Decision unavailable')));

    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(false);
    toastError('Decision unavailable');
  });

  it('shows rejected decisions without claiming success', async () => {
    ipc.invoke.mockResolvedValue({ error: 'Snapshot changed', success: false });
    render(<TeamDecisionCard decision={decision} run={teamRun({ status: 'waiting' })} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Fix the issues' }));
    fireEvent.click(screen.getByTestId('team-decision-confirm'));
    await flush();

    toastError('Snapshot changed');
    expect(screen.getByTestId('team-decision-confirm').hasAttribute('disabled')).toBe(false);
  });

  it.each<SerializableActionResult>([
    { message: 'Cancelled', type: 'info' },
    { message: 'Cannot merge', type: 'error' },
    { callbackId: 'conflict', message: 'Conflicts remain', title: 'Merge Conflicts Detected', type: 'choice' },
    { message: 'Choose a branch', title: 'Select target', type: 'choice' },
  ])('does not finish a merge for a $type action even when the pane is absent', async (result) => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.TEAM_PREPARE_MERGE) return { paneId: 'developer', success: true };
      if (channel === IPC.PANE_MERGE) return result;
      return { success: true };
    });
    render(<TeamFinalCard run={teamRun({ status: 'ready' })} />);
    fireEvent.click(screen.getByTestId('team-merge'));
    await flush();

    expect(ipc.invoke.mock.calls.some(([channel]) => channel === IPC.TEAM_FINISH)).toBe(false);
    expect(screen.getByTestId('team-merge').hasAttribute('disabled')).toBe(false);
  });

  it('leaves durable completion to the successful backend merge instead of issuing a second mutation', async () => {
    usePaneStore.setState({ panes: [{ id: 'developer', paneId: '%1', prompt: 'Build it', slug: 'feature', type: 'worktree' }] });
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.TEAM_PREPARE_MERGE) return { paneId: 'developer', success: true };
      if (channel === IPC.PANE_MERGE) return { message: 'Merged', type: 'success' };
      return { success: true };
    });
    render(<TeamFinalCard run={teamRun({ status: 'ready' })} />);
    fireEvent.click(screen.getByTestId('team-merge'));
    await flush();

    expect(ipc.invoke).toHaveBeenCalledWith(IPC.PANE_MERGE, { paneId: 'developer' });
    expect(ipc.invoke.mock.calls.some(([channel]) => channel === IPC.TEAM_FINISH)).toBe(false);
    expect(screen.getByTestId('team-merge').hasAttribute('disabled')).toBe(false);
  });

  it('restores merge availability when preparation rejects', async () => {
    ipc.invoke.mockRejectedValue(new Error('Preparation unavailable'));
    render(<TeamFinalCard run={teamRun({ status: 'ready' })} />);
    fireEvent.click(screen.getByTestId('team-merge'));
    await flush();

    toastError('Preparation unavailable');
    expect(screen.getByTestId('team-merge').hasAttribute('disabled')).toBe(false);
  });

  it.each([
    { error: 'Snapshot needs review', success: false },
    { success: true },
  ])('does not invoke merge or finish when preparation is incomplete: $success', async (response) => {
    ipc.invoke.mockResolvedValue(response);
    render(<TeamFinalCard run={teamRun({ status: 'ready' })} />);
    fireEvent.click(screen.getByTestId('team-merge'));
    await flush();

    expect(ipc.invoke.mock.calls.map(([channel]) => channel)).toEqual([IPC.TEAM_PREPARE_MERGE]);
    expect(useNotificationStore.getState().toasts.at(-1)?.severity).toBe('error');
    expect(screen.getByTestId('team-merge').hasAttribute('disabled')).toBe(false);
  });

  it('clearly labels waived approval and retains its reason', () => {
    render(<TeamFinalCard run={teamRun({
      approval: { at: 1, kind: 'waiver', reason: 'Prototype only', snapshotSha: 'snapshot', targetSha: 'target' },
      status: 'ready',
    })} />);

    expect(screen.getByText('Approval waived')).toBeTruthy();
    expect(screen.getByText('Prototype only')).toBeTruthy();
    expect(screen.queryByText('Review approved')).toBeNull();
  });

  it('restores start availability after rejection and does not submit twice', async () => {
    const response = deferred<TeamActionResponse>();
    render(<TeamLaunchForm />);
    await flush();
    ipc.invoke.mockReturnValue(response.promise);
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByTestId('team-start'));
    fireEvent.click(screen.getByTestId('team-start'));
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === IPC.TEAM_START)).toHaveLength(1);
    await act(async () => response.reject(new Error('Start unavailable')));

    toastError('Start unavailable');
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(false);
  });

  it('does not select a late start result from the previous project', async () => {
    const response = deferred<TeamStartResponse>();
    useTeamStore.getState().setActiveProjectRoot('/project/a');
    render(<TeamLaunchForm />);
    await flush();
    ipc.invoke.mockReturnValue(response.promise);
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByTestId('team-start'));
    act(() => {
      useTeamStore.getState().setActiveProjectRoot('/project/b');
      useTeamStore.getState().upsertRun(teamRun({ id: 'run-b', projectRoot: '/project/b' }));
    });
    await act(async () => response.resolve({ run: teamRun(), success: true }));

    expect(useTeamStore.getState().activeRunId).toBe('run-b');
    expect(useTeamStore.getState().runs.map((run) => run.id)).toEqual(['run-b']);
  });

  it('submits finite configurable default budgets', async () => {
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({ limits: { maxDurationMs: 3_600_000, maxTokens: 1_000_000 } }));

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Token budget' }), { target: { value: '200000' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Time budget in minutes' }), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_START, expect.objectContaining({ limits: { maxDurationMs: 1_200_000, maxTokens: 200_000 } }));
  });

  it.each(['', '0', '-1', '1e309', '1.5', '9007199254740992'])('rejects invalid token budget %j before starting', async (budget) => {
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build it' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Token budget' }), { target: { value: budget } });

    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(true);
  });

  it('shows durable finished usage, budgets, and stopping without offering another stop', async () => {
    useTeamStore.setState({
      activeRunId: 'run-a',
      runs: [teamRun({ limits: { maxDurationMs: 3_600_000, maxTokens: 1_000_000 }, status: 'stopping', tokenUsage: 12_000 })],
    });
    render(<TeamRoomView />);
    expect(screen.getByTestId('team-status').textContent).toBe('Stopping');
    expect(screen.queryByTestId('team-stop')).toBeNull();
    expect(isRunLive(teamRun({ status: 'stopping' }))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Run context', exact: true }));
    expect(screen.getByTestId('team-usage').textContent).toMatch(/12K \/ 1M.*\/ 60m/);
  });

  it('shows stop failures, disables duplicates, and keeps the actual status', async () => {
    const response = deferred<TeamActionResponse>();
    ipc.invoke.mockReturnValue(response.promise);
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun()] });
    render(<TeamRoomView />);
    fireEvent.click(screen.getByTestId('team-stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(screen.getByRole('button', { name: 'Stop run' }).hasAttribute('disabled')).toBe(true);
    await act(async () => response.resolve({ error: 'Could not stop the Developer', success: false }));

    toastError('Could not stop the Developer');
    expect(screen.getByTestId('team-status').textContent).toBe('Working');
    expect(screen.getByRole('button', { name: 'Stop run' }).hasAttribute('disabled')).toBe(false);
  });

  it('retains a failed note and prevents duplicate pending submissions', async () => {
    const response = deferred<TeamActionResponse>();
    ipc.invoke.mockReturnValue(response.promise);
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun()] });
    render(<TeamRoomView />);
    const input = screen.getByRole('textbox', { name: 'Message the team' });
    fireEvent.change(input, { target: { value: 'Please keep the API stable' } });
    const form = input.closest('form');
    if (!form) throw new Error('Missing note form');
    input.focus();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.hasAttribute('readonly')).toBe(true);
    expect(document.activeElement).toBe(input);
    fireEvent.submit(form);
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === IPC.TEAM_NOTE)).toHaveLength(1);
    await act(async () => response.reject(new Error('Note unavailable')));

    toastError('Note unavailable');
    expect((input as HTMLInputElement).value).toBe('Please keep the API stable');
    expect(input.hasAttribute('readonly')).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('offers publication recovery instead of a stop the backend rejects for a pending merge intent', async () => {
    const approval = { at: 1, kind: 'review' as const, snapshotSha: 'snapshot', targetSha: 'target' };
    const mergeIntent = { approval, operationId: 'op', sourcePaneId: 'developer', sourceSha: 'source', state: 'prepared' as const, targetRef: 'refs/heads/main', targetSha: 'target' };
    usePaneStore.setState({ panes: [{ id: 'developer', paneId: '%1', prompt: 'Build it', slug: 'feature', type: 'worktree' }] });
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun({
      error: 'Team publication was interrupted during checkout.',
      members: [{ agent: 'codex', label: 'Developer', paneId: 'developer', readOnly: false, role: 'developer', worktreePath: '/project/a/writer' }],
      mergeIntent,
      status: 'failed',
    })] });
    render(<TeamRoomView />);

    expect(canStopRun(teamRun({ mergeIntent, status: 'ready' }))).toBe(false);
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry publishing' }));
    await flush();

    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_FINISH, { outcome: 'merged', runId: 'run-a' });
  });

  it('lets a run stuck while stopping try stopping again', async () => {
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun({ error: 'Could not close the reviewer pane', status: 'stopping' })] });
    render(<TeamRoomView />);
    fireEvent.click(screen.getByRole('button', { name: 'Try stopping again' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Try stopping again' }));
    await flush();

    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_FINISH, { outcome: 'stopped', runId: 'run-a' });
  });

  it('does not offer notes or promise another sealed round while stopping', () => {
    const run = teamRun({ status: 'stopping' });
    useTeamStore.setState({ activeRunId: 'run-a', runs: [run] });
    render(<TeamRoomView />);
    expect(screen.queryByRole('textbox', { name: 'Message the team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send note' })).toBeNull();
    expect(screen.getByText('Stopping agents and checks. Writer work is preserved.')).toBeTruthy();
    render(<TeamSealedRound round={{
      baselines: {}, failures: {}, id: 'round', kind: 'design', notes: [], number: 1, openedAt: 1,
      participants: ['architect'], positions: {}, reminded: [], undelivered: [],
    }} run={run} />);

    expect(screen.getAllByText('Stopping')).toHaveLength(2);
    expect(screen.queryByText('Thinking alone')).toBeNull();
    expect(screen.queryByText(/Sealed until all are in/)).toBeNull();
  });

  it('surfaces a rejected agent catalog without enabling a partial roster', async () => {
    ipc.invoke.mockRejectedValue(new Error('Agent catalog unavailable'));
    render(<TeamLaunchForm />);
    await flush();

    expect(screen.getByRole('alert').textContent).toContain('Agent catalog unavailable');
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(true);

    ipc.invoke.mockImplementation(async (channel: string) => channel === IPC.AGENT_LIST ? ['claude', 'codex'] : undefined);
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await flush();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('radio', { name: /Pair/ })).toBeTruthy();
  });

  it('shows a failed start response and restores start availability', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => channel === IPC.AGENT_LIST
      ? ['claude', 'codex'] : { error: 'Run limit reached', success: false });
    render(<TeamLaunchForm />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Brief' }), { target: { value: 'Build it' } });
    fireEvent.click(screen.getByTestId('team-start'));
    await flush();

    toastError('Run limit reached');
    expect(screen.getByTestId('team-start').hasAttribute('disabled')).toBe(false);
  });

  it('surfaces a stop rejection and permits retry without changing run status', async () => {
    ipc.invoke.mockRejectedValue(new Error('Stop unavailable'));
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun()] });
    render(<TeamRoomView />);
    fireEvent.click(screen.getByTestId('team-stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    await flush();

    toastError('Stop unavailable');
    expect(screen.getByRole('button', { name: 'Stop run' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('team-status').textContent).toBe('Working');
  });

  it('surfaces a backend merge rejection and restores merge availability', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.TEAM_PREPARE_MERGE) return { paneId: 'developer', success: true };
      if (channel === IPC.PANE_MERGE) throw new Error('Merge finalization unavailable');
      return { success: true };
    });
    render(<TeamFinalCard run={teamRun({ status: 'ready' })} />);
    fireEvent.click(screen.getByTestId('team-merge'));
    await flush();
    toastError('Merge finalization unavailable');
    expect(screen.getByTestId('team-merge').hasAttribute('disabled')).toBe(false);
  });

  it('waits for pushed stopped state instead of fabricating completion from stop success', async () => {
    const response = deferred<TeamActionResponse>();
    ipc.invoke.mockReturnValue(response.promise);
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun()] });
    render(<TeamRoomView />);
    fireEvent.click(screen.getByTestId('team-stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    act(() => useTeamStore.setState({ runs: [teamRun({ revision: 2, status: 'stopping' })] }));
    await act(async () => response.resolve({ success: true }));

    expect(screen.getByTestId('team-status').textContent).toBe('Stopping');
    expect(screen.queryByTestId('team-stop')).toBeNull();
    act(() => useTeamStore.setState({ runs: [teamRun({ revision: 3, status: 'stopped', tokenUsage: 12_000 })] }));
    expect(screen.getByTestId('team-status').textContent).toBe('Stopped');
    expect(screen.getByTestId('team-tokens').textContent).toContain('12K');
  });

  it('keeps a note when the backend refuses it and clears it only on success', async () => {
    ipc.invoke.mockResolvedValueOnce({ error: 'Run is not ready for notes', success: false })
      .mockResolvedValueOnce({ success: true });
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun()] });
    render(<TeamRoomView />);
    const input = screen.getByRole('textbox', { name: 'Message the team' }) as HTMLInputElement;
    const form = input.closest('form');
    if (!form) throw new Error('Missing note form');
    fireEvent.change(input, { target: { value: 'Keep the API stable' } });
    fireEvent.submit(form);
    await flush();

    toastError('Run is not ready for notes');
    expect(input.value).toBe('Keep the API stable');
    fireEvent.submit(form);
    await flush();
    expect(input.value).toBe('');
  });
});

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from '../../src/renderer/components/shared/Toast';
import { TeamChannel } from '../../src/renderer/components/team/TeamChannel';
import { TeamModePicker } from '../../src/renderer/components/team/TeamModePicker';
import { usePaneStore } from '../../src/renderer/stores/pane.store';
import { useTeamStore } from '../../src/renderer/stores/team.store';
import { useUiStore } from '../../src/renderer/stores/ui.store';
import type { TeamDecision } from '../../src/shared/team-types';
import { teamRun } from './team-test-support';

vi.mock('../../src/renderer/api/ipc', () => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
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
      layout: _layout,
      transition: _transition,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & Record<'animate' | 'exit' | 'initial' | 'layout' | 'transition', unknown>) => (
      <div {...props}>{children}</div>
    ),
    span: ({ layoutId: _layoutId, transition: _transition, ...props }: React.HTMLAttributes<HTMLSpanElement> & Record<'layoutId' | 'transition', unknown>) => <span {...props} />,
  },
}));

const winnerDecision: TeamDecision = {
  id: 'winner', kind: 'duel-winner', label: 'D-1', openedAt: 1,
  options: [{ holders: [], id: 'writer-a', title: 'Select Writer A' }, { holders: [], id: 'writer-b', title: 'Select Writer B' }],
  settled: [], title: 'Which Duel candidate should continue?', why: 'The comparison is advisory.',
};

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  usePaneStore.setState({ panes: [] });
  useTeamStore.setState({ activeProjectRoot: '/project', activeRunId: null, launchOpen: true, runs: [] });
  useUiStore.setState({ activeView: 'settings', viewMode: 'fleet' });
});
afterEach(cleanup);

describe('Team attention and comparison UX', () => {
  it('opens the notifying run from its toast', () => {
    // Arrange
    const run = teamRun({ id: 'run-b', projectRoot: '/project' });
    useTeamStore.setState({ activeRunId: 'run-a', runs: [teamRun({ id: 'run-a', projectRoot: '/project' }), run] });
    const onDismiss = vi.fn();
    const toast = { dismissMs: 10_000, id: 't-1', message: 'Team needs your call', severity: 'warning' as const, teamReady: { projectRoot: '/project', runId: 'run-b' }, timestamp: 1 };

    // Act
    render(<Toast onDismiss={onDismiss} toast={toast} />);
    fireEvent.click(screen.getByTestId('toast-open-team'));

    // Assert
    expect(useUiStore.getState()).toMatchObject({ activeView: 'dashboard', viewMode: 'team' });
    expect(useTeamStore.getState()).toMatchObject({ activeRunId: 'run-b', launchOpen: false });
    expect(onDismiss).toHaveBeenCalledWith('t-1');
  });

  it('moves the mode selection with arrow keys as a single radio group', () => {
    // Arrange
    const onChange = vi.fn();
    render(<TeamModePicker onChange={onChange} value="pair" />);
    const pair = screen.getByRole('radio', { name: /Pair/ });

    // Act
    fireEvent.keyDown(pair, { key: 'ArrowRight' });
    fireEvent.keyDown(pair, { key: 'ArrowLeft' });

    // Assert
    expect(pair.getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    expect(onChange.mock.calls).toEqual([['duel'], ['council']]);
  });

  it('places both candidate diffs beside the Duel winner decision', () => {
    // Arrange
    const run = teamRun({
      decisions: [winnerDecision], mode: 'duel', status: 'waiting',
      members: [
        { agent: 'codex', label: 'Writer A', paneId: 'writer-a', readOnly: false, role: 'developer', worktreePath: '/project/a' },
        { agent: 'claude', label: 'Writer B', paneId: 'writer-b', readOnly: false, role: 'architect', worktreePath: '/project/b' },
      ],
    });
    usePaneStore.setState({ panes: [
      { id: 'writer-a', paneId: '%1', prompt: 'Build', slug: 'writer-a', worktreePath: '/project/a' },
      { id: 'writer-b', paneId: '%2', prompt: 'Build', slug: 'writer-b', worktreePath: '/project/b' },
    ] });

    // Act
    render(<TeamChannel run={run} />);
    const nextAction = screen.getByTestId('team-next-action');
    fireEvent.click(within(nextAction).getByRole('button', { name: 'View writer B changes' }));

    // Assert
    expect(within(nextAction).getByTestId('team-duel-candidates')).toBeTruthy();
    expect(screen.getAllByTestId('team-duel-candidates')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Writer B changes' })).toBeTruthy();
    expect(screen.getByText('Diff for writer-b')).toBeTruthy();
  });
});

import { mkdtempSync, rmSync } from 'fs';
import type { MuxBasePane } from 'muxbase/core';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveTeamRecoveryPane,
  type TeamPaneBinding,
} from '../../src/main/services/bridge/teamPaneRecovery.js';
import type { TeamMember } from '../../src/shared/team-types.js';

describe('team pane recovery bindings', () => {
  let directory: string;
  let member: TeamMember;
  const run = { brief: 'Fix the regression', id: 'run', projectRoot: '/project' };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'muxbase-team-recovery-'));
    member = {
      agent: 'claude',
      label: 'Architect',
      paneId: 'member',
      readOnly: true,
      role: 'architect',
      worktreePath: directory,
    };
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  function dependencies(bindings: TeamPaneBinding[] = []) {
    return {
      listBindings: async () => bindings,
      recreatePane: vi.fn(async (pane: MuxBasePane) => ({ ...pane, paneId: '%8' })),
    };
  }

  it('recreates a missing logical pane in the preserved worktree with the same member identity', async () => {
    const ports = dependencies();

    const result = await resolveTeamRecoveryPane(undefined, member, run, ports);

    expect(result).toMatchObject({
      created: true,
      pane: { id: 'member', paneId: '%8', role: 'review', teamRunId: 'run', worktreePath: directory },
    });
    expect(ports.recreatePane).toHaveBeenCalledOnce();
  });

  it('rebinds a surviving owned tmux pane instead of launching a duplicate', async () => {
    const ports = dependencies([{ cwd: directory, logicalPaneId: member.paneId, paneId: '%7' }]);

    const result = await resolveTeamRecoveryPane(undefined, member, run, ports);

    expect(result).toMatchObject({ created: false, pane: { paneId: '%7', id: member.paneId } });
    expect(ports.recreatePane).not.toHaveBeenCalled();
  });

  it('refuses recovery when another worker occupies the same worktree', async () => {
    const ports = dependencies([{ cwd: directory, logicalPaneId: 'another-member', paneId: '%7' }]);

    await expect(resolveTeamRecoveryPane(undefined, member, run, ports)).rejects.toThrow('duplicate workers');

    expect(ports.recreatePane).not.toHaveBeenCalled();
  });

  it('fails closed when the tmux binding query fails', async () => {
    const ports = dependencies();
    ports.listBindings = async () => { throw new Error('tmux is unavailable'); };

    await expect(resolveTeamRecoveryPane(undefined, member, run, ports)).rejects.toThrow('tmux is unavailable');

    expect(ports.recreatePane).not.toHaveBeenCalled();
  });

  it('preserves model and branch metadata while replacing a dead tmux binding', async () => {
    const ports = dependencies();
    const existing: MuxBasePane = {
      agent: 'claude',
      branchName: 'team-debate',
      effort: 'high',
      id: member.paneId,
      model: 'opus',
      paneId: '%5',
      prompt: 'Initial prompt',
      slug: 'original',
      worktreePath: directory,
    };

    const result = await resolveTeamRecoveryPane(existing, member, run, ports);

    expect(result.pane).toMatchObject({ branchName: 'team-debate', effort: 'high', model: 'opus', slug: 'original' });
  });

  it('restores writable Duel candidate B with its recorded tuning even without the original pane', async () => {
    const ports = dependencies();
    const candidate: TeamMember = {
      ...member,
      effort: 'high',
      model: 'opus',
      readOnly: false,
    };

    const result = await resolveTeamRecoveryPane(undefined, candidate, run, ports);

    expect(result.pane).toMatchObject({ effort: 'high', model: 'opus', role: undefined, worktreePath: directory });
    expect(ports.recreatePane).toHaveBeenCalledWith(expect.objectContaining({
      effort: 'high', model: 'opus', role: undefined,
    }));
  });
});

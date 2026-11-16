import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamEvent, TeamRun, TeamRunSeed } from '../../src/shared/team-types.js';
import { log } from '../../src/main/services/Logger.js';
import { TeamLedger } from '../../src/main/services/team/TeamLedger.js';
import { appendTeamEvent, loadTeamRuns } from '../../src/main/services/team/TeamRunStore.js';
import { createTeamRound } from '../../src/main/services/team/teamProtocol.js';

let root: string;
let file: string;
let seed: TeamRunSeed;

function journal(events: TeamEvent[], at = 100): string {
  return `${JSON.stringify({ at, events, version: 1 })}\n`;
}

beforeEach(() => {
  vi.spyOn(log, 'error').mockImplementation(() => {});
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  root = resolve(`.team-journal-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  const directory = join(root, '.muxbase', 'teams', 'run-1');
  mkdirSync(directory, { recursive: true });
  file = join(directory, 'events.ndjson');
  seed = {
    baseSha: 'abc',
    brief: 'Implement the brief',
    createdAt: 100,
    id: 'run-1',
    policy: 'when-stuck',
    projectRoot: root,
    title: 'Test run',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  rmSync(root, { force: true, recursive: true });
});

describe('team journal recovery', () => {
  it('retains an uncertain external check until its result and next step are committed together', () => {
    const ledger = new TeamLedger(() => root, () => {});
    ledger.commit(seed.id, { seed, type: 'created' });
    ledger.commit(seed.id, { pending: true, type: 'check-execution' });

    expect(loadTeamRuns(root)[0].checkPending).toBe(true);

    ledger.transaction(seed.id, () => {
      ledger.commit(seed.id, { pending: false, type: 'check-execution' });
      ledger.commit(seed.id, { next: 'review', type: 'next' });
    });

    const restored = loadTeamRuns(root)[0];
    expect(restored.checkPending).toBe(false);
    expect(restored.next).toBe('review');
  });

  it('repairs an incomplete final record before consecutive durable appends', () => {
    writeFileSync(file, `${JSON.stringify({ at: 100, event: { seed, type: 'created' } })}\n{"at":101,"event":`);
    const warning = vi.spyOn(log, 'warn');

    expect(loadTeamRuns(root)[0].title).toBe(seed.title);
    appendTeamEvent(root, seed.id, { text: 'first survives', type: 'note' }, 102);
    appendTeamEvent(root, seed.id, { text: 'second survives', type: 'note' }, 103);

    expect(loadTeamRuns(root)[0].pendingNotes).toEqual(['first survives', 'second survives']);
    expect(warning).toHaveBeenCalled();
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
  });

  it.each([
    ['complete malformed tail', '{broken}\n'],
    ['complete malformed interior', '{broken}\n{"at":300,"event":{"type":"note","text":"later"}}\n'],
    ['schema-invalid event', '{"at":200,"event":{"type":"position"}}\n'],
    ['unknown version', '{"version":2,"at":200,"events":[]}\n'],
    ['complete invalid record without newline', '{"at":200,"event":{"type":"bogus"}}'],
    ['non-incomplete malformed record without newline', '{"at":!}'],
    ['unknown round reference', '{"at":200,"event":{"type":"round-closed","roundId":"missing","outcome":"done"}}\n'],
    ['invalid usage checkpoint', '{"at":200,"event":{"type":"usage","tokens":0,"checkpoints":{"session":-1}}}\n'],
    ['invalid native model', `${JSON.stringify({ at: 200, event: { member: {
      agent: 'codex', label: 'Candidate B', model: 42, paneId: 'writer-b', readOnly: false,
      role: 'architect', worktreePath: '/project/writer-b',
    }, type: 'member' } })}\n`],
    ['invalid native effort', `${JSON.stringify({ at: 200, event: { member: {
      agent: 'codex', effort: [], label: 'Candidate B', paneId: 'writer-b', readOnly: false,
      role: 'architect', worktreePath: '/project/writer-b',
    }, type: 'member' } })}\n`],
  ])('retains a failed reconstructed run and blocks appends for %s', (_name, tail) => {
    writeFileSync(file, `${JSON.stringify({ at: 100, event: { seed, type: 'created' } })}\n${tail}`);
    const diagnostic = vi.spyOn(log, 'error');

    const recovered = loadTeamRuns(root)[0];

    expect(recovered?.id).toBe(seed.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error).toMatch(/journal|recover|corrupt/i);
    expect(() => appendTeamEvent(root, seed.id, { text: 'must not append', type: 'note' }, 400)).toThrow(/journal|recover|corrupt/i);
    expect(diagnostic).toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toContain(tail);
  });

  it('replays legacy and versioned records with one revision per record', () => {
    writeFileSync(file, `${JSON.stringify({ at: 100, event: { seed, type: 'created' } })}\n${journal([
      { text: 'one', type: 'note' },
      { text: 'two', type: 'note' },
    ], 200)}`);

    const run = loadTeamRuns(root)[0];

    expect(run.pendingNotes).toEqual(['one', 'two']);
    expect(run.revision).toBe(2);
    expect(run.updatedAt).toBe(200);
  });

  it('preserves a complete valid final record without a newline', () => {
    writeFileSync(file, JSON.stringify({ at: 100, event: { seed, type: 'created' } }));

    appendTeamEvent(root, seed.id, { text: 'after complete tail', type: 'note' }, 200);

    expect(loadTeamRuns(root)[0].pendingNotes).toEqual(['after complete tail']);
    expect(loadTeamRuns(root)[0].revision).toBe(2);
  });

  it('recovers every incomplete byte prefix of a versioned record', () => {
    const created = journal([{ seed, type: 'created' }]);
    const record = JSON.stringify({ at: 200, events: [{ text: 'A note', type: 'note' }], version: 1 });

    for (let end = 1; end < record.length; end += 1) {
      writeFileSync(file, `${created}${record.slice(0, end)}`);
      expect(() => appendTeamEvent(root, seed.id, { text: 'After repair', type: 'note' }, 300), `prefix ending at byte ${end}`).not.toThrow();
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    }
    expect(loadTeamRuns(root)[0].pendingNotes).toEqual(['After repair']);
  });

  it.each([
    ['run id', { id: 'other-run' }],
    ['project root', { projectRoot: '/another-project' }],
  ])('rejects a seed with mismatched %s', (_name, change) => {
    writeFileSync(file, journal([{ seed: { ...seed, ...change }, type: 'created' }]));
    const diagnostic = vi.spyOn(log, 'error');

    expect(loadTeamRuns(root)).toEqual([]);
    expect(diagnostic).toHaveBeenCalled();
    expect(() => appendTeamEvent(root, seed.id, { text: 'blocked', type: 'note' }, 200)).toThrow();
  });

  it('does not partially apply an invalid transaction record', () => {
    writeFileSync(file, `${journal([{ seed, type: 'created' }])}${JSON.stringify({
      at: 200,
      events: [{ text: 'must not leak', type: 'note' }, { status: 'bogus', type: 'status' }],
      version: 1,
    })}\n`);

    const recovered = loadTeamRuns(root)[0];

    expect(recovered?.status).toBe('failed');
    expect(recovered?.pendingNotes).toEqual([]);
    expect(recovered?.revision).toBe(1);
  });

  it('replays all new safety metadata through the durable schema', () => {
    const approval = {
      at: 200,
      checkedSnapshot: 'checked',
      decisionId: 'decision',
      kind: 'waiver' as const,
      reason: 'Human accepted the residual risk',
      snapshotSha: 'snapshot',
      targetSha: 'target',
    };
    writeFileSync(file, journal([{ seed: {
      ...seed,
      limits: { maxDurationMs: 1000, maxTokens: 2000 },
      plannedMembers: [{ agent: 'claude', role: 'developer' }],
    }, type: 'created' }]));

    const instance = new TeamLedger(() => root, () => {});
    instance.list();
    instance.transaction(seed.id, () => {
      instance.commit(seed.id, { sha: 'checked', type: 'check-snapshot' });
      instance.commit(seed.id, { step: 'review', type: 'recovery' });
      instance.commit(seed.id, { tokens: 30, type: 'usage' });
      instance.commit(seed.id, { approval, type: 'approved' });
    });

    expect(loadTeamRuns(root)[0]).toMatchObject({
      approval,
      approvedSnapshot: 'snapshot',
      checkedSnapshot: 'checked',
      limits: { maxDurationMs: 1000, maxTokens: 2000 },
      plannedMembers: [{ agent: 'claude', role: 'developer' }],
      recoveryStep: 'review',
      revision: 2,
      tokenUsage: 30,
    });
  });

  it.each([undefined, 'review-session'])('persists review target and delivery intent atomically with session %s', (sessionId) => {
    appendTeamEvent(root, seed.id, { seed, type: 'created' }, 100);
    const instance = new TeamLedger(() => root, () => {});
    instance.list();
    const review = { ...createTeamRound(instance.get(seed.id), 'review', ['architect'], 'snapshot'), targetSha: 'target' };

    instance.transaction(seed.id, () => {
      instance.commit(seed.id, { round: review, type: 'round-opened' });
      instance.commit(seed.id, { role: 'architect', roundId: review.id, sessionId, state: 'pending', type: 'delivery-attempt' });
      instance.commit(seed.id, { baseline: 5, role: 'architect', roundId: review.id, type: 'delivered' });
    });

    const recovered = loadTeamRuns(root)[0];
    expect(recovered.rounds[0]).toMatchObject({
      baselines: { architect: 5 },
      deliveryAttempts: { architect: { state: 'pending' } },
      snapshotSha: 'snapshot',
      targetSha: 'target',
      undelivered: [],
    });
    expect(recovered.rounds[0].deliveryAttempts?.architect?.sessionId).toBe(sessionId);
    expect(recovered.revision).toBe(2);
    expect(recovered).toEqual(instance.get(seed.id));
  });

  it('preserves session-linked delivery metadata in a persisted round', () => {
    appendTeamEvent(root, seed.id, { seed, type: 'created' }, 100);
    const round = createTeamRound(loadTeamRuns(root)[0], 'review', ['architect'], 'snapshot');
    round.deliveryAttempts = { architect: { at: 100, sessionId: 'review-session', state: 'pending' } };

    appendTeamEvent(root, seed.id, { round, type: 'round-opened' }, 200);

    expect(loadTeamRuns(root)[0].rounds[0].deliveryAttempts).toEqual(round.deliveryAttempts);
  });

  it('persists additive usage and checkpoint snapshots together in one record', () => {
    appendTeamEvent(root, seed.id, { seed, type: 'created' }, 100);
    const instance = new TeamLedger(() => root, () => {});
    instance.list();
    const checkpoints = { 'developer:pane:new-session': 0, 'developer:pane:old-session': 10 };

    instance.transaction(seed.id, () => {
      instance.commit(seed.id, { checkpoints, tokens: 10, type: 'usage' });
      instance.commit(seed.id, { tokens: 5, type: 'usage' });
    });

    const recovered = loadTeamRuns(root)[0];
    expect(recovered).toMatchObject({ revision: 2, tokenUsage: 15, usageCheckpoints: checkpoints });
    expect(recovered).toEqual(instance.get(seed.id));
    const stored = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[1]);
    expect(stored.events[0].checkpoints).toEqual(checkpoints);
    expect(stored.events).toHaveLength(2);
  });
});

describe('TeamLedger durable transactions', () => {
  function ledger() {
    const emissions: TeamRun[] = [];
    const instance = new TeamLedger(() => root, (run) => emissions.push(run));
    instance.commit(seed.id, { seed, type: 'created' });
    emissions.length = 0;
    return { emissions, instance };
  }

  it('persists commit, feed, and lead together and emits only the final revision', () => {
    const { emissions, instance } = ledger();

    instance.transaction(seed.id, () => {
      instance.commit(seed.id, { next: 'build', type: 'next' });
      instance.feed(seed.id, { kind: 'human', text: 'Approved' });
      instance.lead(seed.id, 'Starting implementation');
      expect(emissions).toHaveLength(0);
      expect(instance.get(seed.id).next).toBe('build');
    });

    const records = readFileSync(file, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[1].version).toBe(1);
    expect(records[1].events).toHaveLength(3);
    expect(emissions).toHaveLength(1);
    expect(emissions[0].revision).toBe(2);
    expect(loadTeamRuns(root)[0]).toEqual(instance.get(seed.id));
  });

  it('rolls back all draft changes when the operation throws', () => {
    const { emissions, instance } = ledger();
    const before = instance.get(seed.id);
    const bytes = readFileSync(file, 'utf8');

    expect(() => instance.transaction(seed.id, () => {
      instance.lead(seed.id, 'Must not survive');
      instance.commit(seed.id, { next: 'review', type: 'next' });
      throw new Error('aborted');
    })).toThrow('aborted');

    expect(instance.get(seed.id)).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(emissions).toHaveLength(0);
  });

  it('rolls back the draft when the journal refuses the write', () => {
    const { emissions, instance } = ledger();
    const before = instance.get(seed.id);
    appendFileSync(file, '{invalid}\n');

    expect(() => instance.transaction(seed.id, () => {
      instance.lead(seed.id, 'Not persisted');
    })).toThrow(/journal|recover|corrupt/i);

    expect(instance.get(seed.id)).toEqual(before);
    expect(emissions).toHaveLength(0);
  });

  it('supports same-run nested transactions in one record', () => {
    const { emissions, instance } = ledger();

    instance.transaction(seed.id, () => {
      instance.lead(seed.id, 'outer');
      instance.transaction(seed.id, () => instance.lead(seed.id, 'inner'));
    });

    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(emissions).toHaveLength(1);
    expect(emissions[0].feed.map((item) => item.kind === 'lead' ? item.text : '')).toEqual(['outer', 'inner']);
  });

  it('rejects cross-run commits without leaking an outer draft', () => {
    const { emissions, instance } = ledger();

    expect(() => instance.transaction(seed.id, () => {
      instance.lead(seed.id, 'outer');
      instance.commit('other', { seed: { ...seed, id: 'other' }, type: 'created' });
    })).toThrow(/run|transaction/i);

    expect(instance.get(seed.id).feed).toEqual([]);
    expect(instance.find('other')).toBeUndefined();
    expect(emissions).toHaveLength(0);
  });

  it('rejects an async operation without publishing synchronous draft changes', () => {
    const { emissions, instance } = ledger();

    expect(() => instance.transaction(seed.id, async () => {
      instance.lead(seed.id, 'not synchronous');
    })).toThrow(/async|synchronous/i);

    expect(instance.get(seed.id).feed).toEqual([]);
    expect(emissions).toHaveLength(0);
  });

  it('rolls back a nested savepoint if its exception is handled by the outer operation', () => {
    const { emissions, instance } = ledger();

    instance.transaction(seed.id, () => {
      instance.lead(seed.id, 'outer survives');
      expect(() => instance.transaction(seed.id, () => {
        instance.lead(seed.id, 'inner rolled back');
        throw new Error('inner failed');
      })).toThrow('inner failed');
      instance.lead(seed.id, 'outer continues');
    });

    expect(emissions[0].feed).toHaveLength(2);
    expect(emissions[0].feed.map((item) => item.kind === 'lead' ? item.text : '')).toEqual(['outer survives', 'outer continues']);
    expect(loadTeamRuns(root)[0]).toEqual(instance.get(seed.id));
  });

  it('publishes nothing for an empty transaction', () => {
    const { emissions, instance } = ledger();
    const bytes = readFileSync(file, 'utf8');

    instance.transaction(seed.id, () => {});

    expect(emissions).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(instance.get(seed.id).revision).toBe(1);
  });

  it('does not let caller mutation diverge the transaction draft from its durable events', () => {
    const { instance } = ledger();
    const agreement = { at: 200, source: 'human', text: 'Original agreement' };

    instance.transaction(seed.id, () => {
      instance.commit(seed.id, { agreement, type: 'agreement' });
      agreement.text = 'Mutated outside the journal';
    });

    expect(instance.get(seed.id).agreements[0].text).toBe('Original agreement');
    expect(loadTeamRuns(root)[0]).toEqual(instance.get(seed.id));
  });

  it('fsyncs exactly one record before publishing the final transaction', () => {
    const { emissions, instance } = ledger();
    const flush = vi.spyOn(fs, 'fsyncSync');
    syncBuiltinESMExports();

    instance.transaction(seed.id, () => {
      instance.lead(seed.id, 'First');
      instance.lead(seed.id, 'Second');
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(emissions).toHaveLength(1);
    expect(loadTeamRuns(root)[0].feed).toHaveLength(2);
  });

  it('rolls back appended bytes and the draft when fsync fails', () => {
    const { emissions, instance } = ledger();
    const before = instance.get(seed.id);
    const bytes = readFileSync(file, 'utf8');
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected fsync failure'); });
    syncBuiltinESMExports();

    expect(() => instance.transaction(seed.id, () => {
      instance.lead(seed.id, 'Must not survive failed persistence');
    })).toThrow('injected fsync failure');

    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(instance.get(seed.id)).toEqual(before);
    expect(emissions).toHaveLength(0);
    expect(loadTeamRuns(root)[0]).toEqual(before);
  });
});

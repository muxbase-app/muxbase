import type { TeamRun } from '../../src/shared/team-types';

export function teamRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    agreements: [],
    baseSha: 'base',
    brief: 'Build a feature',
    createdAt: 1,
    decisions: [],
    designRoundFloor: 0,
    dissent: [],
    feed: [],
    fixAttempts: 0,
    id: 'run-a',
    members: [],
    pendingNotes: [],
    policy: 'when-stuck',
    projectRoot: '/project/a',
    rounds: [],
    stage: 'design',
    status: 'running',
    title: 'Feature',
    updatedAt: 1,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

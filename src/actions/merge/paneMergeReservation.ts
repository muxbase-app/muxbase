import { AsyncLocalStorage } from 'node:async_hooks';
import type { MuxBasePane } from '../../types.js';
import type { ActionResult } from '../types.js';

const pendingMerges = new Map<string, Promise<ActionResult>>();
const mergeScope = new AsyncLocalStorage<{ active: boolean; key: string }>();

export async function reservePaneMerge(
  pane: MuxBasePane,
  operation: () => Promise<ActionResult>,
): Promise<ActionResult> {
  const key = `${pane.projectRoot ?? pane.worktreePath ?? ''}:${pane.id}`;
  const inherited = mergeScope.getStore();
  if (inherited?.active && inherited.key === key) return reserveCallbacks(pane, await operation());
  const existing = pendingMerges.get(key);
  if (existing) return existing;
  const scope = { active: true, key };
  const pending = Promise.resolve().then(() => mergeScope.run(scope, operation)).then((result) => reserveCallbacks(pane, result));
  pendingMerges.set(key, pending);
  try {
    return await pending;
  } finally {
    scope.active = false;
    if (pendingMerges.get(key) === pending) pendingMerges.delete(key);
  }
}

function reserveCallbacks(pane: MuxBasePane, result: ActionResult): ActionResult {
  const { onCancel, onConfirm, onSelect, onSubmit } = result;
  return {
    ...result,
    ...(onCancel ? { onCancel: () => reservePaneMerge(pane, onCancel) } : {}),
    ...(onConfirm ? { onConfirm: () => reservePaneMerge(pane, onConfirm) } : {}),
    ...(onSelect ? { onSelect: (value: string) => reservePaneMerge(pane, () => onSelect(value)) } : {}),
    ...(onSubmit ? { onSubmit: (value: string) => reservePaneMerge(pane, () => onSubmit(value)) } : {}),
  };
}

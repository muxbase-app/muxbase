import { describe, expect, it, vi } from 'vitest';
import { reservePaneMerge } from '../../../src/actions/merge/paneMergeReservation.js';
import type { ActionResult } from '../../../src/actions/types.js';

const pane = { id: 'writer', paneId: '%1', prompt: 'Build', slug: 'writer', worktreePath: '/target/writer' };

describe('Team source merge reservation', () => {
  it('permits a nested retry in the owning flow without waiting on itself', async () => {
    const result = await reservePaneMerge(pane, () => reservePaneMerge(pane, async () => ({
      message: 'Nested retry completed', type: 'success',
    })));
    expect(result).toMatchObject({ type: 'success' });
  });

  it('keeps duplicate initial validation out while the approved merge callback is completing', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const complete = vi.fn(async (): Promise<ActionResult> => {
      await gate;
      return { message: 'Merged and finalized', type: 'success' };
    });
    const dialog = await reservePaneMerge(pane, async () => ({
      message: 'Approve merge', onConfirm: complete, type: 'confirm',
    }));
    const first = dialog.onConfirm!();
    const duplicateValidation = vi.fn(async (): Promise<ActionResult> => {
      throw new Error('Would revoke the now-moving approval');
    });
    const second = reservePaneMerge(pane, duplicateValidation);
    finish();

    expect(await first).toMatchObject({ type: 'success' });
    expect(await second).toMatchObject({ type: 'success' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(duplicateValidation).not.toHaveBeenCalled();
  });

  it('deduplicates callbacks from separate pending dialogs and releases after rejection', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const submit = vi.fn(async (): Promise<ActionResult> => {
      await gate;
      throw new Error('Commit failed');
    });
    const dialog = await reservePaneMerge(pane, async () => ({
      message: 'Commit message', onSubmit: submit, type: 'input',
    }));
    const first = dialog.onSubmit!('message');
    const second = dialog.onSubmit!('message');
    finish();
    await expect(first).rejects.toThrow('Commit failed');
    await expect(second).rejects.toThrow('Commit failed');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await reservePaneMerge(pane, async () => ({ message: 'Retry', type: 'info' }))).toMatchObject({ type: 'info' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoApproveTrustPrompt, clearAgentStartupPrompt } from '../../src/utils/autoApproveTrustPrompt.js';

const capture = vi.hoisted(() => vi.fn());
const sendKeys = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../src/utils/paneCapture.js', () => ({
  capturePaneContent: capture,
  capturePaneVisible: capture,
}));

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => ({ sendTmuxKeys: sendKeys }) },
}));

describe('agent startup folder trust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capture.mockReturnValue('Quick safety check\n❯ 1. Yes, I trust this folder\nEnter to confirm');
  });

  it('does not accept folder trust without explicit consent', async () => {
    vi.useFakeTimers();
    try {
      const pending = clearAgentStartupPrompt('%1');
      await vi.runAllTimersAsync();

      expect(await pending).toBe(false);
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-accept folder trust through the background launch poller', async () => {
    vi.useFakeTimers();
    try {
      const pending = autoApproveTrustPrompt('%1');
      await vi.runAllTimersAsync();
      await pending;

      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a caller with explicit consent to confirm folder trust', async () => {
    vi.useFakeTimers();
    try {
      const pending = clearAgentStartupPrompt('%1', true);
      await vi.runAllTimersAsync();

      expect(await pending).toBe(true);
      expect(sendKeys).toHaveBeenCalledWith('%1', 'Enter');
    } finally {
      vi.useRealTimers();
    }
  });

  it('can dismiss an incompatible daemon without granting folder trust', async () => {
    capture.mockReturnValue('Background server has incompatible version\n› 1. Run without daemon this time');
    vi.useFakeTimers();
    try {
      const pending = clearAgentStartupPrompt('%1');
      await vi.runAllTimersAsync();

      expect(await pending).toBe(true);
      expect(sendKeys).toHaveBeenCalledWith('%1', '1');
    } finally {
      vi.useRealTimers();
    }
  });
});

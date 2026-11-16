import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const instances: Array<{ handlers: Record<string, () => void>; options: { body: string; title: string }; show: ReturnType<typeof vi.fn> }> = [];
  class Notification {
    static isSupported = vi.fn(() => true);
    handlers: Record<string, () => void> = {};
    show = vi.fn();
    constructor(public options: { body: string; title: string }) {
      instances.push(this);
    }
    on(event: string, handler: () => void) {
      this.handlers[event] = handler;
      return this;
    }
  }
  return { instances, Notification };
});
vi.mock('electron', () => ({ Notification: electron.Notification }));

import type { BrowserWindow } from 'electron';
import { showTeamAttentionNotification } from '../../src/main/services/team/teamAttentionNotifier';

function windowStub(focused: boolean) {
  return {
    focus: vi.fn(), isDestroyed: () => false, isFocused: () => focused, isMinimized: () => true, restore: vi.fn(), show: vi.fn(),
  };
}

describe('Team attention notification', () => {
  const environment = { ...process.env };
  beforeEach(() => {
    electron.instances.length = 0;
    delete process.env.MUXBASE_E2E;
  });
  afterEach(() => {
    process.env = { ...environment };
  });

  it('stays silent while the user is already looking at MuxBase', () => {
    // Arrange
    const window = windowStub(true);

    // Act
    showTeamAttentionNotification(window as unknown as BrowserWindow, 'Team needs your call', vi.fn());

    // Assert
    expect(electron.instances).toHaveLength(0);
  });

  it('brings the window back and reopens the in-app notice when clicked', () => {
    // Arrange
    const window = windowStub(false);
    const onOpen = vi.fn();
    showTeamAttentionNotification(window as unknown as BrowserWindow, 'Team needs your call', onOpen);
    const [notification] = electron.instances;

    // Act
    notification.handlers.click();

    // Assert
    expect(notification.options).toEqual({ body: 'Team needs your call', title: 'MuxBase Team' });
    expect(notification.show).toHaveBeenCalledOnce();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

import { type BrowserWindow, Notification } from 'electron';
import { isHeadlessE2E } from '../../e2e-window-mode.js';

const TITLE = 'MuxBase Team';
const pending = new Set<Notification>();

export function showTeamAttentionNotification(window: BrowserWindow | null, message: string, onOpen: () => void): void {
  if (!window || window.isDestroyed() || window.isFocused()) return;
  if (isHeadlessE2E(process.env) || !Notification.isSupported()) return;
  const notification = new Notification({ body: message, title: TITLE });
  const release = () => pending.delete(notification);
  notification.on('click', () => {
    release();
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    onOpen();
  });
  notification.on('close', release);
  pending.add(notification);
  notification.show();
}

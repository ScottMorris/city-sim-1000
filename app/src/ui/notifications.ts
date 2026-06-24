import { dismissToast, showToast, type ToastOptions } from './dialogs';

export type NotificationSeverity = 'info' | 'warning' | 'success';

export interface Notification {
  id?: string;
  message: string;
  severity?: NotificationSeverity;
  sticky?: boolean;
}

export function createNotificationCenter() {
  const publish = (notification: Notification) => {
    const options: ToastOptions = {
      severity: notification.severity,
      sticky: notification.sticky,
      id: notification.id
    };
    showToast(notification.message, options);
  };

  const resolve = (id: string) => {
    dismissToast(id);
  };

  return { publish, resolve };
}

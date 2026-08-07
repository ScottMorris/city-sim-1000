// notifications.ts — a small publish/resolve facade over dialogs.ts's toast system.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { dismissToast, showToast, type ToastOptions, type ToastSeverity } from './dialogs';

/** Alias, not a second declaration — `ToastSeverity` (`dialogs.ts`) is the
 *  one definition; this name stays for callers that think in terms of a
 *  "notification" rather than a "toast". */
export type NotificationSeverity = ToastSeverity;

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

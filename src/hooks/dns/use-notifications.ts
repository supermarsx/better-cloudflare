import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TauriClient,
  type AppNotification,
  type NotificationCheckKind,
  type NotificationQuery,
  type NotificationServiceStatus,
  type UnlistenFn,
} from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

export interface UseNotificationsOptions {
  /** Query sent to `notifications_list`; defaults to `{ scope: "all" }`. */
  query?: NotificationQuery;
  /** `false` skips every IPC call (e.g. the tab is not open). Off-desktop is always disabled. */
  enabled?: boolean;
}

export interface UseNotificationsResult {
  items: AppNotification[];
  unread: number;
  status: NotificationServiceStatus | null;
  loading: boolean;
  error: string | null;
  /** `false` on the web build — every action is a no-op there. */
  available: boolean;
  refresh: () => Promise<void>;
  markRead: (ids: string[], read?: boolean) => Promise<void>;
  markAllRead: () => Promise<void>;
  archive: (ids: string[]) => Promise<void>;
  unarchive: (ids: string[]) => Promise<void>;
  archiveAllRead: () => Promise<void>;
  dismiss: (ids: string[]) => Promise<void>;
  clearArchived: () => Promise<void>;
  checkNow: (kind?: NotificationCheckKind) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown notifications error";
}

function reportNotificationFailure(error: unknown, label: string): void {
  reportRuntimeError(error, { source: "runtime", label });
}

function queryKey(query: NotificationQuery | undefined): string {
  return JSON.stringify({
    scope: query?.scope ?? "all",
    kind: query?.kind ?? null,
    zoneId: query?.zoneId ?? null,
    limit: query?.limit ?? null,
    before: query?.before ?? null,
  });
}

/**
 * Inbox state for the Notifications tab. Loads the list + unread count +
 * service status from the desktop backend, subscribes to
 * `notifications://changed` / `notifications://status`, and exposes the inbox
 * actions. Mutations are applied optimistically and then reconciled with a
 * refresh. Everything is a no-op when `!isDesktop()`.
 */
export function useNotifications(
  options: UseNotificationsOptions = {},
): UseNotificationsResult {
  const available = isDesktop();
  const enabled = available && options.enabled !== false;
  const key = queryKey(options.query);
  const query = useMemo<NotificationQuery>(
    () => ({ scope: "all", ...(options.query ?? {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState<NotificationServiceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const refreshSeq = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const seq = ++refreshSeq.current;
    setLoading(true);
    try {
      const [list, count, serviceStatus] = await Promise.all([
        TauriClient.notificationsList(query),
        TauriClient.notificationsUnreadCount(),
        TauriClient.notificationsStatus().catch((statusError: unknown) => {
          reportNotificationFailure(statusError, "Read notification status");
          return null;
        }),
      ]);
      if (!mountedRef.current || seq !== refreshSeq.current) return;
      setItems(list);
      setUnread(count);
      if (serviceStatus) setStatus(serviceStatus);
      setError(null);
    } catch (refreshError) {
      if (!mountedRef.current || seq !== refreshSeq.current) return;
      setError(describeError(refreshError));
      reportNotificationFailure(refreshError, "Load notifications");
    } finally {
      if (mountedRef.current && seq === refreshSeq.current) setLoading(false);
    }
  }, [enabled, query]);

  // Initial load + reload when the query changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Backend events.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const dispose = () => {
      for (const unlisten of unlisteners.splice(0)) {
        try {
          unlisten();
        } catch (disposeError) {
          reportNotificationFailure(
            disposeError,
            "Unsubscribe from notification events",
          );
        }
      }
    };
    const subscribe = async () => {
      const [changed, statusChanged] = await Promise.all([
        TauriClient.onNotificationsChanged((payload) => {
          if (!mountedRef.current) return;
          setUnread(payload.unread);
          void refresh();
        }),
        TauriClient.onNotificationsStatus((payload) => {
          if (!mountedRef.current) return;
          setStatus(payload);
          setUnread(payload.unread);
        }),
      ]);
      if (cancelled) {
        changed();
        statusChanged();
        return;
      }
      unlisteners.push(changed, statusChanged);
    };
    void subscribe().catch((subscribeError) =>
      reportNotificationFailure(
        subscribeError,
        "Subscribe to notification events",
      ),
    );
    return () => {
      cancelled = true;
      dispose();
    };
  }, [enabled, refresh]);

  const run = useCallback(
    async (
      label: string,
      optimistic: ((current: AppNotification[]) => AppNotification[]) | null,
      action: () => Promise<unknown>,
    ) => {
      if (!enabled) return;
      if (optimistic) setItems((current) => optimistic(current));
      let failure: string | null = null;
      try {
        await action();
      } catch (actionError) {
        failure = describeError(actionError);
        reportNotificationFailure(actionError, label);
      }
      // Reconcile with the backend either way; a successful refresh clears
      // `error`, so the action failure is re-applied afterwards.
      await refresh();
      if (failure && mountedRef.current) setError(failure);
    },
    [enabled, refresh],
  );

  const now = () => new Date().toISOString();

  const markRead = useCallback(
    (ids: string[], read = true) =>
      run(
        read ? "Mark notifications read" : "Mark notifications unread",
        (current) =>
          current.map((item) =>
            ids.includes(item.id)
              ? { ...item, readAt: read ? (item.readAt ?? now()) : null }
              : item,
          ),
        () => TauriClient.notificationsMarkRead(ids, read),
      ),
    [run],
  );

  const markAllRead = useCallback(
    () =>
      run(
        "Mark all notifications read",
        (current) =>
          current.map((item) =>
            item.readAt || item.archivedAt ? item : { ...item, readAt: now() },
          ),
        () => TauriClient.notificationsMarkAllRead(),
      ),
    [run],
  );

  const archive = useCallback(
    (ids: string[]) =>
      run(
        "Archive notifications",
        (current) =>
          query.scope === "archived"
            ? current
            : current.filter((item) => !ids.includes(item.id)),
        () => TauriClient.notificationsArchive(ids),
      ),
    [run, query.scope],
  );

  const unarchive = useCallback(
    (ids: string[]) =>
      run(
        "Unarchive notifications",
        (current) =>
          query.scope === "archived"
            ? current.filter((item) => !ids.includes(item.id))
            : current,
        () => TauriClient.notificationsUnarchive(ids),
      ),
    [run, query.scope],
  );

  const archiveAllRead = useCallback(
    () =>
      run(
        "Archive read notifications",
        (current) =>
          query.scope === "archived"
            ? current
            : current.filter((item) => !item.readAt || item.archivedAt),
        () => TauriClient.notificationsArchiveAllRead(),
      ),
    [run, query.scope],
  );

  const dismiss = useCallback(
    (ids: string[]) =>
      run(
        "Dismiss notifications",
        (current) => current.filter((item) => !ids.includes(item.id)),
        () => TauriClient.notificationsDismiss(ids),
      ),
    [run],
  );

  const clearArchived = useCallback(
    () =>
      run(
        "Clear archived notifications",
        (current) => current.filter((item) => !item.archivedAt),
        () => TauriClient.notificationsClearArchived(),
      ),
    [run],
  );

  const checkNow = useCallback(
    (kind?: NotificationCheckKind) =>
      run("Run notification check", null, async () => {
        const next = await TauriClient.notificationsCheckNow(kind);
        if (mountedRef.current) setStatus(next);
      }),
    [run],
  );

  const pause = useCallback(
    () =>
      run("Pause notification monitoring", null, async () => {
        const next = await TauriClient.notificationsPause();
        if (mountedRef.current) setStatus(next);
      }),
    [run],
  );

  const resume = useCallback(
    () =>
      run("Resume notification monitoring", null, async () => {
        const next = await TauriClient.notificationsResume();
        if (mountedRef.current) setStatus(next);
      }),
    [run],
  );

  return {
    items,
    unread,
    status,
    loading,
    error,
    available,
    refresh,
    markRead,
    markAllRead,
    archive,
    unarchive,
    archiveAllRead,
    dismiss,
    clearArchived,
    checkNow,
    pause,
    resume,
  };
}

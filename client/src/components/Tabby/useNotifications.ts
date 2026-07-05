/**
 * @file useNotifications.ts
 * @description Notification inbox state for the Tabby ball (Phase O). Seeds from
 *   GET /api/notifications, then stays live off the shared event bus:
 *   `notification_created` upserts (the facade coalesces by id) and fires the
 *   optional onArrive callback (the nudge bubble); `notification_read` syncs
 *   read state across devices. Unread count seeds from the server and is
 *   adjusted by deltas; refresh() re-syncs (called when the inbox tab opens).
 * @author Jarvis (Phase O)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { eventBus } from "../../lib/eventBus";
import { api } from "../../lib/api";
import type { AppNotification, NotificationReadPayload, WSMessage } from "../../lib/types";

const LIST_LIMIT = 50;

export interface NotificationInbox {
  items: AppNotification[];
  unread: number;
  markRead: (id: string) => void;
  readAll: () => void;
  refresh: () => void;
}

export function useNotifications(onArrive?: (n: AppNotification) => void): NotificationInbox {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const onArriveRef = useRef(onArrive);
  onArriveRef.current = onArrive;
  // Mirror of `items` for the WS handler to compute unread deltas without
  // setState-inside-setState (double-decrement guard for our own echoes).
  const itemsRef = useRef<AppNotification[]>([]);
  itemsRef.current = items;

  const refresh = useCallback(() => {
    api.notifications
      .list({ limit: LIST_LIMIT })
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unread);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "notification_created") {
        const n = msg.data as AppNotification;
        if (!n || typeof n.id !== "string") return;
        const prev = itemsRef.current;
        const existed = prev.some((p) => p.id === n.id);
        const existedUnread = prev.some((p) => p.id === n.id && !p.read_at);
        if (!n.read_at && !existedUnread) setUnread((u) => u + 1);
        const rest = existed ? prev.filter((p) => p.id !== n.id) : prev.slice(0, LIST_LIMIT - 1);
        setItems([n, ...rest]);
        onArriveRef.current?.(n);
      } else if (msg.type === "notification_read") {
        const p = msg.data as NotificationReadPayload;
        const now = new Date().toISOString();
        if (p?.all) {
          setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
          setUnread(0);
        } else if (Array.isArray(p?.ids) && p.ids.length) {
          const ids = new Set(p.ids);
          // Only decrement for ids that are locally unread - our own optimistic
          // markRead already flipped them, so its echo is a no-op here.
          const delta = itemsRef.current.filter((n) => ids.has(n.id) && !n.read_at).length;
          if (delta > 0) setUnread((u) => Math.max(0, u - delta));
          setItems((prev) =>
            prev.map((n) => (ids.has(n.id) && !n.read_at ? { ...n, read_at: now } : n))
          );
        }
      }
    });
  }, []);

  // Optimistic: the WS notification_read echo re-applies harmlessly.
  const markRead = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n))
    );
    setUnread((u) => Math.max(0, u - 1));
    api.notifications.markRead(id).catch(() => undefined);
  }, []);

  const readAll = useCallback(() => {
    setItems((prev) =>
      prev.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() }))
    );
    setUnread(0);
    api.notifications.readAll().catch(() => undefined);
  }, []);

  return { items, unread, markRead, readAll, refresh };
}

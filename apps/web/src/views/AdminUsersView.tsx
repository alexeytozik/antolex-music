import { useCallback, useEffect, useRef, useState } from "react";

import { AdminIcon, SpinnerIcon } from "../components/Icons";
import { useInfiniteSentinel } from "../hooks/useInfiniteTrackFeed";
import { api } from "../lib/api";
import type { AccessStatus, AdminHLSBackfillResponse, AdminUser } from "../types";

const STATUS_LABELS: Record<AccessStatus, string> = {
  pending: "Pending",
  active: "Active",
  blocked: "Blocked",
};

function appendUniqueUsers(current: AdminUser[], incoming: AdminUser[]) {
  const users = new Map(current.map((user) => [user.id, user]));
  incoming.forEach((user) => users.set(user.id, user));
  return Array.from(users.values());
}

function isAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function formatJoinedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Join date unavailable";
  return `Joined ${new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date)}`;
}

export function AdminUsersView() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatingStatuses, setUpdatingStatuses] = useState<Record<string, "active" | "blocked">>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [hlsBackfill, setHLSBackfill] = useState<AdminHLSBackfillResponse | null>(null);
  const [hlsLoading, setHLSLoading] = useState(false);
  const [hlsError, setHLSError] = useState<string | null>(null);
  const [retryingHLSTracks, setRetryingHLSTracks] = useState<Record<string, boolean>>({});
  const [hlsActionErrors, setHLSActionErrors] = useState<Record<string, string>>({});
  const loadingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const requestIDRef = useRef(0);
  const hlsControllerRef = useRef<AbortController | null>(null);
  const hlsRequestIDRef = useRef(0);

  const loadPage = useCallback(async (cursor: string | null, append: boolean) => {
    if (loadingRef.current) return;

    const requestID = requestIDRef.current + 1;
    requestIDRef.current = requestID;
    const controller = new AbortController();
    controllerRef.current = controller;
    loadingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const response = await api.getAdminUsers(cursor, controller.signal);
      if (requestID !== requestIDRef.current) return;
      setUsers((current) =>
        append ? appendUniqueUsers(current, response.results) : response.results,
      );
      setNextCursor(response.next_cursor ?? null);
    } catch (reason) {
      if (requestID === requestIDRef.current && !isAbortError(reason)) {
        setError(reason instanceof Error ? reason.message : "Could not load users");
      }
    } finally {
      if (requestID === requestIDRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  const loadHLSBackfill = useCallback(async () => {
    const requestID = hlsRequestIDRef.current + 1;
    hlsRequestIDRef.current = requestID;
    hlsControllerRef.current?.abort();
    const controller = new AbortController();
    hlsControllerRef.current = controller;
    setHLSLoading(true);
    setHLSError(null);

    try {
      const response = await api.getAdminHLSBackfill(controller.signal);
      if (requestID !== hlsRequestIDRef.current) return;
      setHLSBackfill(response);
    } catch (reason) {
      if (requestID === hlsRequestIDRef.current && !isAbortError(reason)) {
        setHLSError(
          reason instanceof Error
            ? reason.message
            : "Could not load background playback status",
        );
      }
    } finally {
      if (requestID === hlsRequestIDRef.current) setHLSLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(null, false);
    void loadHLSBackfill();
    return () => {
      requestIDRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      loadingRef.current = false;
      hlsRequestIDRef.current += 1;
      hlsControllerRef.current?.abort();
      hlsControllerRef.current = null;
    };
  }, [loadHLSBackfill, loadPage]);

  const loadMore = useCallback(() => {
    if (nextCursor) void loadPage(nextCursor, true);
  }, [loadPage, nextCursor]);
  const sentinelRef = useInfiniteSentinel(
    loadMore,
    Boolean(nextCursor) && !loading && !error,
  );

  async function updateStatus(
    user: AdminUser,
    status: Extract<AccessStatus, "active" | "blocked">,
  ) {
    if (updatingStatuses[user.id] || user.is_admin) return;
    setUpdatingStatuses((current) => ({ ...current, [user.id]: status }));
    setActionErrors((current) => {
      const next = { ...current };
      delete next[user.id];
      return next;
    });

    try {
      const updated = await api.updateAdminUserStatus(user.id, status);
      setUsers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (reason) {
      setActionErrors((current) => ({
        ...current,
        [user.id]: reason instanceof Error ? reason.message : "Could not update access",
      }));
    } finally {
      setUpdatingStatuses((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
    }
  }

  function retry() {
    void loadPage(users.length > 0 ? nextCursor : null, users.length > 0);
  }

  async function retryHLSBackfill(trackID: string) {
    if (retryingHLSTracks[trackID]) return;
    setRetryingHLSTracks((current) => ({ ...current, [trackID]: true }));
    setHLSActionErrors((current) => {
      const next = { ...current };
      delete next[trackID];
      return next;
    });

    try {
      await api.retryAdminHLSBackfill(trackID);
      await loadHLSBackfill();
    } catch (reason) {
      setHLSActionErrors((current) => ({
        ...current,
        [trackID]: reason instanceof Error ? reason.message : "Could not retry this track",
      }));
    } finally {
      setRetryingHLSTracks((current) => {
        const next = { ...current };
        delete next[trackID];
        return next;
      });
    }
  }

  return (
    <section className="view-stack admin-view" aria-label="Owner administration">
      <section className="admin-hls-panel" aria-labelledby="admin-hls-heading">
        <div className="admin-section-heading">
          <div>
            <p className="eyebrow">Background playback</p>
            <h2 id="admin-hls-heading">HLS preparation</h2>
          </div>
          <button
            className="secondary-button compact"
            type="button"
            disabled={hlsLoading}
            onClick={() => void loadHLSBackfill()}
          >
            {hlsLoading ? "Checking…" : "Refresh"}
          </button>
        </div>

        {hlsError && (
          <div className="feed-error">
            <p className="notice notice-error" role="alert">{hlsError}</p>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => void loadHLSBackfill()}
            >
              Retry
            </button>
          </div>
        )}

        {hlsBackfill && (
          <>
            <div className="admin-hls-metrics" aria-label="HLS preparation progress">
              <span>
                <strong>{hlsBackfill.summary.hls_ready}</strong>
                Ready of {hlsBackfill.summary.ready_tracks}
              </span>
              <span>
                <strong>{hlsBackfill.summary.preparing}</strong>
                Preparing
              </span>
              <span className={hlsBackfill.summary.failed > 0 ? "has-error" : undefined}>
                <strong>{hlsBackfill.summary.failed}</strong>
                Failed
              </span>
            </div>

            {hlsBackfill.summary.complete ? (
              <p className="notice notice-success">
                All tracks are ready for continuous background playback.
              </p>
            ) : (
              <p className="admin-hls-progress">
                Tracks continue to use the regular player until their background playback copy is ready.
                {hlsBackfill.summary.missing > 0 && (
                  <> {hlsBackfill.summary.missing} {hlsBackfill.summary.missing === 1 ? "track is" : "tracks are"} waiting to be queued.</>
                )}
              </p>
            )}

            {hlsBackfill.failures.length > 0 && (
              <div className="admin-hls-failures">
                {hlsBackfill.failures.length < hlsBackfill.summary.failed && (
                  <p className="admin-hls-progress">
                    Showing {hlsBackfill.failures.length} of {hlsBackfill.summary.failed} failed tracks.
                    Retry or refresh to continue through the list.
                  </p>
                )}
                {hlsBackfill.failures.map((failure) => (
                  <article className="admin-hls-failure" key={failure.track_id}>
                    <div className="admin-hls-failure-copy">
                      <strong>{failure.title}</strong>
                      <span>{failure.artist || "Unknown artist"}</span>
                      <p>Preparation stopped after {failure.attempts} attempts.</p>
                      {hlsActionErrors[failure.track_id] && (
                        <p className="admin-user-error" role="alert">
                          {hlsActionErrors[failure.track_id]}
                        </p>
                      )}
                      <details>
                        <summary>Technical details</summary>
                        <code>{failure.error}</code>
                      </details>
                    </div>
                    <button
                      className="primary-button compact"
                      type="button"
                      disabled={Boolean(retryingHLSTracks[failure.track_id])}
                      onClick={() => void retryHLSBackfill(failure.track_id)}
                      aria-label={`Retry HLS preparation for ${failure.title}`}
                    >
                      {retryingHLSTracks[failure.track_id] ? "Queuing…" : "Retry"}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {hlsLoading && !hlsBackfill && !hlsError && (
          <div className="feed-loading" role="status">
            <SpinnerIcon className="h-5 w-5 animate-spin" />
            Checking background playback
          </div>
        )}
      </section>

      <div className="view-heading admin-heading">
        <div>
          <p className="eyebrow">Owner access</p>
          <h1 id="admin-users-heading">Users</h1>
        </div>
        <span className="count-pill" aria-label={`${users.length} users loaded`}>
          {users.length}
        </span>
      </div>

      {error && (
        <div className="feed-error">
          <p className="notice notice-error" role="alert">{error}</p>
          <button className="secondary-button compact" type="button" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      <div className="admin-user-list">
        {users.map((user) => {
          const updatingStatus = updatingStatuses[user.id];
          const updating = Boolean(updatingStatus);
          return (
            <article className="admin-user-row" key={user.id}>
              <div className="admin-user-copy">
                <strong>{user.email}</strong>
                <span>{formatJoinedAt(user.created_at)}</span>
                {actionErrors[user.id] && (
                  <p className="admin-user-error" role="alert">{actionErrors[user.id]}</p>
                )}
              </div>

              <span className={`admin-status status-${user.access_status}`}>
                {user.is_admin ? "Owner" : STATUS_LABELS[user.access_status]}
              </span>

              <div className="admin-user-actions">
                {user.is_admin ? (
                  <span className="admin-owner-note">Protected account</span>
                ) : (
                  <>
                    {user.access_status !== "active" && (
                      <button
                        className="primary-button compact"
                        type="button"
                        disabled={updating}
                        onClick={() => void updateStatus(user, "active")}
                        aria-label={`Approve ${user.email}`}
                      >
                        {updatingStatus === "active" ? "Saving…" : "Approve"}
                      </button>
                    )}
                    {user.access_status !== "blocked" && (
                      <button
                        className="secondary-button compact danger"
                        type="button"
                        disabled={updating}
                        onClick={() => void updateStatus(user, "blocked")}
                        aria-label={`Block ${user.email}`}
                      >
                        {updatingStatus === "blocked" ? "Saving…" : "Block"}
                      </button>
                    )}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!loading && !error && users.length === 0 && (
        <div className="empty-state">
          <AdminIcon className="h-8 w-8" />
          <p>No users to manage.</p>
        </div>
      )}

      <div ref={sentinelRef} className="feed-sentinel" aria-hidden="true" />
      {loading && (
        <div className="feed-loading" role="status">
          <SpinnerIcon className="h-5 w-5 animate-spin" />
          Loading users
        </div>
      )}
      {!loading && !error && nextCursor && users.length > 0 && (
        <button className="secondary-button admin-load-more" type="button" onClick={loadMore}>
          Load more users
        </button>
      )}
      {!loading && !nextCursor && users.length > 0 && (
        <p className="feed-end">All users loaded.</p>
      )}
    </section>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Shell } from "./components/Shell";
import { QueueContinuation } from "./components/QueueContinuation";
import { UploadManagerProvider } from "./components/UploadManager";
import { APIError, SESSION_INVALIDATED_EVENT, api } from "./lib/api";
import {
  removeLegacyPlayerStorage,
  usePlayerStore,
} from "./store/player-store";
import { AddView } from "./views/AddView";
import { AdminUsersView } from "./views/AdminUsersView";
import { LikedSongsView } from "./views/LikedSongsView";
import { ProfileView } from "./views/ProfileView";
import { SearchView } from "./views/SearchView";

function PrivateRoute({ children, ready }: { children: ReactNode; ready: boolean }) {
  const user = usePlayerStore((state) => state.user);
  if (!ready) return <div className="app-loading">Loading ANTOLEX Music…</div>;
  if (!user) return <Navigate to="/profile" replace />;
  return children;
}

export function AdminRoute({ children, ready }: { children: ReactNode; ready: boolean }) {
  const user = usePlayerStore((state) => state.user);
  if (!ready) return <div className="app-loading">Loading ANTOLEX Music…</div>;
  if (!user) return <Navigate to="/profile" replace />;
  if (!user.is_admin) return <Navigate to="/" replace />;
  return children;
}

export function SessionInvalidationListener() {
  const clearSession = usePlayerStore((state) => state.clearSession);

  useEffect(() => {
    const invalidate = () => clearSession();
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate);
  }, [clearSession]);

  return null;
}

function SessionBootstrap({ onReady }: { onReady: () => void }) {
  const token = usePlayerStore((state) => state.token);
  const user = usePlayerStore((state) => state.user);
  const sessionExpiresAt = usePlayerStore((state) => state.sessionExpiresAt);
  const setSession = usePlayerStore((state) => state.setSession);
  const clearSession = usePlayerStore((state) => state.clearSession);
  const loadLikes = usePlayerStore((state) => state.loadLikes);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        if (token) {
          const session = await api.exchangeLegacyToken(token);
          if (!cancelled) {
            setSession(null, session.user, session.session_expires_at);
            removeLegacyPlayerStorage();
          }
          return;
        }
        const profile = await api.getProfile();
        if (!cancelled) {
          setSession(
            null,
            profile,
            sessionExpiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
          );
        }
      } catch (reason) {
        if (!cancelled && reason instanceof APIError && (reason.status === 401 || reason.status === 403)) {
          if (user || token) clearSession();
          if (token) removeLegacyPlayerStorage();
        }
      } finally {
        if (!cancelled) onReady();
      }
    }
    void restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (user) void loadLikes().catch(() => undefined);
  }, [loadLikes, user]);
  return null;
}

export default function App() {
  const [sessionReady, setSessionReady] = useState(false);
  const userID = usePlayerStore((state) => state.user?.id);
  const clearSession = usePlayerStore((state) => state.clearSession);
  return (
    <>
      <SessionInvalidationListener />
      <SessionBootstrap onReady={() => setSessionReady(true)} />
      <QueueContinuation />
      <UploadManagerProvider
        key={userID ?? "guest"}
        enabled={sessionReady && !!userID}
        userKey={userID}
        onUnauthorized={clearSession}
      >
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<PrivateRoute ready={sessionReady}><SearchView /></PrivateRoute>} />
            <Route path="/liked" element={<PrivateRoute ready={sessionReady}><LikedSongsView /></PrivateRoute>} />
            <Route path="/add" element={<PrivateRoute ready={sessionReady}><AddView /></PrivateRoute>} />
            <Route path="/admin" element={<AdminRoute ready={sessionReady}><AdminUsersView /></AdminRoute>} />
            <Route path="/profile" element={<ProfileView />} />
            <Route path="/auth" element={<Navigate to="/profile" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </UploadManagerProvider>
    </>
  );
}

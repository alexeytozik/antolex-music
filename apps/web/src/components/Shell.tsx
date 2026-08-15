import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { AdminIcon, HeartIcon, LogOutIcon, PlusIcon, SearchIcon, UserIcon } from "./Icons";
import { Player } from "./Player";
import { api } from "../lib/api";
import {
  isGlobalPlaybackShortcut,
  isSpaceKey,
} from "../lib/playback-shortcuts";
import { selectCurrentItem, usePlayerStore } from "../store/player-store";

export function Shell() {
  const user = usePlayerStore((state) => state.user);
  const clearSession = usePlayerStore((state) => state.clearSession);
  const currentItem = usePlayerStore(selectCurrentItem);
  const [signingOut, setSigningOut] = useState(false);
  const keyboardNavigationRef = useRef(true);
  const consumedSpaceRef = useRef(false);
  const links = [
    { to: "/", label: "Search", icon: SearchIcon, end: true },
    { to: "/liked", label: "Liked", icon: HeartIcon },
    { to: "/add", label: "Add", icon: PlusIcon },
    ...(user?.is_admin
      ? [{ to: "/admin", label: "Admin", icon: AdminIcon }]
      : []),
  ];

  useEffect(() => {
    function markPointerNavigation() {
      keyboardNavigationRef.current = false;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Tab") keyboardNavigationRef.current = true;
      if (!isGlobalPlaybackShortcut(event, keyboardNavigationRef.current)) return;

      const player = usePlayerStore.getState();
      if (!player.user || !selectCurrentItem(player)) return;

      event.preventDefault();
      event.stopPropagation();
      consumedSpaceRef.current = true;
      if (event.repeat) return;
      player.togglePlayback();
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (!consumedSpaceRef.current || !isSpaceKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      consumedSpaceRef.current = false;
    }

    function resetConsumedSpace() {
      consumedSpaceRef.current = false;
    }

    function resetWhenHidden() {
      if (document.visibilityState === "hidden") resetConsumedSpace();
    }

    window.addEventListener("pointerdown", markPointerNavigation, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", resetConsumedSpace);
    document.addEventListener("visibilitychange", resetWhenHidden);
    return () => {
      window.removeEventListener("pointerdown", markPointerNavigation, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", resetConsumedSpace);
      document.removeEventListener("visibilitychange", resetWhenHidden);
    };
  }, []);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    clearSession();
    try {
      await api.logout();
    } catch {
      // Local playback and uploads are already stopped even if the cookie expired.
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className={`app-shell ${user ? "authenticated" : ""} ${user && currentItem ? "has-player" : ""}`}>
      <header className="top-bar">
        <div className="top-bar-inner">
          <div className="brand-lockup mobile-brand">
            <img src="/favicon.svg" alt="" />
            <div><strong>ANTOLEX</strong><span>Music</span></div>
          </div>
          <img className="desktop-brand" src="/logo-wordmark.svg" alt="ANTOLEX Music" />
          {user && (
            <nav className="desktop-nav" aria-label="Main navigation">
              {links.map((link) => (
                <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => isActive ? "active" : undefined} aria-label={link.label} title={link.label}>
                  <link.icon className="h-6 w-6" />
                </NavLink>
              ))}
            </nav>
          )}
          <div className="account-control">
            {user ? (
              <button
                className="account-auth signed-in"
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                aria-busy={signingOut}
                aria-label={signingOut ? "Signing out" : `Signed in as ${user.email}. Sign out`}
                title={signingOut ? "Signing out" : `${user.email} · Sign out`}
              >
                <LogOutIcon className="h-5 w-5" />
                <span>{signingOut ? "Signing out" : "Sign out"}</span>
              </button>
            ) : (
              <Link className="account-auth" to="/profile" aria-label="Sign in" title="Sign in">
                <UserIcon className="h-5 w-5" />
                <span>Sign in</span>
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="app-main"><Outlet /></main>
      {user && <Player />}

      {user && (
        <nav className="bottom-nav" aria-label="Main navigation">
          {links.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => isActive ? "active" : undefined}>
              <link.icon className="h-6 w-6" />
              <span>{link.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

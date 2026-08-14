import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { HeartIcon, LogOutIcon, PlusIcon, SearchIcon, UserIcon } from "./Icons";
import { Player } from "./Player";
import { api } from "../lib/api";
import { selectCurrentItem, usePlayerStore } from "../store/player-store";

export function Shell() {
  const user = usePlayerStore((state) => state.user);
  const clearSession = usePlayerStore((state) => state.clearSession);
  const currentItem = usePlayerStore(selectCurrentItem);
  const [signingOut, setSigningOut] = useState(false);
  const links = [
    { to: "/", label: "Search", icon: SearchIcon, end: true },
    { to: "/liked", label: "Liked", icon: HeartIcon },
    { to: "/add", label: "Add", icon: PlusIcon },
  ];

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.logout();
    } catch {
      // The local session must still be cleared when the cookie already expired.
    } finally {
      clearSession();
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

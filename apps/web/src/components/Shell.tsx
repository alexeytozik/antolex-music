import { NavLink, Outlet } from 'react-router-dom';

import { HeartIcon, SearchIcon, UserIcon } from './Icons';
import { Player } from './Player';
import { usePlayerStore } from '../store/player-store';

const links = [
  { to: '/', label: 'Search', icon: SearchIcon },
  { to: '/liked', label: 'Liked Songs', icon: HeartIcon },
  { to: '/profile', label: 'Profile', icon: UserIcon },
];

export function Shell() {
  const user = usePlayerStore((state) => state.user);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-white/10 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" className="h-11 w-11 rounded-2xl" />
            <p className="text-sm font-semibold tracking-[0.18em] text-zinc-50 uppercase">
              Tozikron
            </p>
          </div>
          <div className="max-w-[40vw] truncate text-right text-xs text-zinc-500">
            {user ? user.email : 'Guest'}
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1.5 px-4 pb-3">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `flex h-11 w-11 items-center justify-center rounded-full text-sm transition ${
                  isActive
                    ? 'bg-white text-zinc-950'
                    : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-50'
                }`
              }
              aria-label={link.label}
              title={link.label}
            >
              <link.icon className="h-[1.35rem] w-[1.35rem]" />
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <Player />
    </div>
  );
}

// Hash routes: the page path never changes, so relative asset and API paths stay right under /petopia/.
import { useEffect, useState } from 'react';

export const TABS = ['overview', 'timeline', 'health', 'care'] as const;
export type Tab = (typeof TABS)[number];
export type Route = { name: 'home' } | { name: 'add' } | { name: 'animals' } | { name: 'inbox' } | { name: 'inbox-item'; id: number } | { name: 'household' } | { name: 'animal'; id: number; tab: Tab } | { name: 'edit'; id: number };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '');
  let m = /^\/animals\/(\d+)\/edit$/.exec(h);
  if (m) return { name: 'edit', id: Number(m[1]) };
  m = /^\/animals\/(\d+)(?:\/([a-z]+))?$/.exec(h);
  if (m) return { name: 'animal', id: Number(m[1]), tab: (TABS as readonly string[]).includes(m[2] ?? '') ? (m[2] as Tab) : 'overview' };
  if (h === '/add') return { name: 'add' };
  if (h === '/animals') return { name: 'animals' };
  if (h === '/inbox') return { name: 'inbox' };
  if (h === '/household') return { name: 'household' };
  m = /^\/inbox\/(\d+)$/.exec(h);
  if (m) return { name: 'inbox-item', id: Number(m[1]) };
  return { name: 'home' };
}

export const go = (path: string): void => {
  window.location.hash = path;
};

export function useRoute(): Route {
  const [r, setR] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setR(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

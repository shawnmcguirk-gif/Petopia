// Hash routes: the page path never changes, so relative asset and API paths stay right under /petopia/.
import { useEffect, useState } from 'react';

export type Route = { name: 'home' } | { name: 'add' } | { name: 'animal'; id: number } | { name: 'edit'; id: number };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '');
  let m = /^\/animals\/(\d+)\/edit$/.exec(h);
  if (m) return { name: 'edit', id: Number(m[1]) };
  m = /^\/animals\/(\d+)$/.exec(h);
  if (m) return { name: 'animal', id: Number(m[1]) };
  if (h === '/add') return { name: 'add' };
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

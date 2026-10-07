// Navigation (spec sec 8.2): Home · Animals · Inbox along the bottom on a phone. Wildlife stays hidden until v2 and the
// Ask button arrives with v1.2 (neither is shown as a promise). Household is a small link, not a tab.
// No paw icons in the chrome (spec sec 9.1): lucide line icons only.
import { Home as HomeIcon, Inbox, Rows3 } from 'lucide-react';
import type { Route } from './route';

export function Nav({ route, waiting }: { route: Route; waiting: number }) {
  const items = [
    { href: '#/', label: 'Home', icon: HomeIcon, on: route.name === 'home' },
    { href: '#/animals', label: 'Animals', icon: Rows3, on: route.name === 'animals' || route.name === 'animal' || route.name === 'edit' || route.name === 'add' },
    { href: '#/inbox', label: 'Inbox', icon: Inbox, on: route.name === 'inbox' || route.name === 'inbox-item', badge: waiting },
  ];
  return (
    <nav aria-label="Petopia" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[color-mix(in_srgb,var(--bg)_94%,transparent)] backdrop-blur" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="mx-auto grid h-16 max-w-md grid-cols-3">
        {items.map((it) => (
          <a key={it.href} href={it.href} aria-current={it.on ? 'page' : undefined} className={`relative flex flex-col items-center justify-center gap-0.5 text-[12px] font-semibold no-underline ${it.on ? 'text-gold' : 'text-ink-2'}`}>
            <it.icon aria-hidden className="h-6 w-6" strokeWidth={1.75} />
            {it.label}
            {!!it.badge && <span className="absolute right-[calc(50%-22px)] top-2 min-w-5 rounded-full bg-gold px-1.5 text-center text-[11px] leading-5 text-on-gold" aria-label={`${it.badge} to check`}>{it.badge}</span>}
          </a>
        ))}
      </div>
    </nav>
  );
}

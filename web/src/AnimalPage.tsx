// Inside an animal (spec sec 8.3): Overview · Timeline · Health · Care & food. "Files & money" waits for S5 / v1.1 and
// is not shown empty. Tabs are hash routes (#/animals/7/health), so the back button and a shared link both work.
import type { Animal } from './api';
import { CareTab } from './CareTab';
import { HealthTab } from './HealthTab';
import { Overview } from './Overview';
import type { Tab } from './route';
import { TimelineTab } from './TimelineTab';

const TAB_WORDS: Record<Tab, string> = { overview: 'Overview', timeline: 'Timeline', health: 'Health', care: 'Care & food' };

export function AnimalPage({ a, tab, onChange, reload }: { a: Animal; tab: Tab; onChange: (a: Animal) => void; reload: () => void }) {
  return (
    <>
      <nav aria-label={`${a.name} sections`} className="sticky top-[calc(56px+env(safe-area-inset-top))] z-10 border-b border-line bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2 sm:px-4">
          {(Object.keys(TAB_WORDS) as Tab[]).map((t) => (
            <a key={t} href={`#/animals/${a.id}${t === 'overview' ? '' : `/${t}`}`} aria-current={tab === t ? 'page' : undefined}
              className={`shrink-0 border-b-2 px-3 py-3 text-[15px] font-semibold no-underline ${tab === t ? 'border-gold text-ink' : 'border-transparent text-ink-2'}`}>
              {TAB_WORDS[t]}
            </a>
          ))}
        </div>
      </nav>
      {tab === 'overview' ? <Overview a={a} onChange={onChange} /> : (
        <main className="mx-auto max-w-3xl px-4 pb-28 sm:px-6">
          {tab === 'timeline' && <TimelineTab a={a} />}
          {tab === 'health' && <HealthTab a={a} onChanged={reload} />}
          {tab === 'care' && <CareTab a={a} onChanged={reload} />}
        </main>
      )}
    </>
  );
}

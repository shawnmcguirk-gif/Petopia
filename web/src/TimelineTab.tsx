// An animal's Timeline (spec sec 3.6, 9.4; S4, A19): every event, newest first, under year headers, each with its
// source badge. Filters: All · Health · Food · Weight (Care and Memories arrive with S6 / v1.1).
import { useEffect, useState } from 'react';
import { ApiError, get, type Animal, type TimelineEntry } from './api';
import { niceDate } from './format';
import { BadgeChip, Card, ErrorText } from './ui';

const FILTERS = [{ key: '', label: 'All' }, { key: 'HEALTH', label: 'Health' }, { key: 'FOOD', label: 'Food' }, { key: 'WEIGHT', label: 'Weight' }] as const;

export function TimelineTab({ a }: { a: Animal }) {
  const [filter, setFilter] = useState<string>('');
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setEntries(null);
    get<TimelineEntry[]>(`api/animals/${a.id}/timeline${filter ? `?category=${filter}` : ''}`)
      .then((e) => { if (live) setEntries(e); })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError ? e.message : 'Could not load the timeline.'); });
    return () => { live = false; };
  }, [a.id, filter]);

  const years: [string, TimelineEntry[]][] = [];
  for (const e of entries ?? []) {
    const last = years[years.length - 1];
    if (last && last[0] === e.year) last[1].push(e);
    else years.push([e.year, [e]]);
  }
  return (
    <div className="mt-6">
      <div className="seg max-w-full overflow-x-auto" role="group" aria-label="Show">
        {FILTERS.map((f) => <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>)}
      </div>
      <ErrorText text={error} />
      {entries === null && !error && <p className="text-ink-2" aria-busy="true">Loading…</p>}
      {entries?.length === 0 && <p className="mt-6 text-ink-2">Nothing on {a.name}’s timeline{filter ? ' here' : ''} yet.</p>}
      {years.map(([year, list]) => (
        <section key={year} aria-label={year} className="mt-8">
          <h3 className="name m-0 mb-3 text-[26px]">{year}</h3>
          <Card className="divide-y divide-line overflow-hidden">
            {list.map((e) => (
              <article key={`${e.ref.table}-${e.ref.id}`} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="m-0 text-[13px] text-ink-2">{niceDate(e.on)} · {e.label}</p>
                  <p className="m-0 font-semibold">{e.title}</p>
                  {e.detail && <p className="m-0 text-[15px] text-ink-2">{e.detail.replace(/^next due (\d{4}-\d{2}-\d{2})$/, (_, d: string) => `next due ${niceDate(d)}`)}</p>}
                </div>
                <BadgeChip badge={e.badge} />
              </article>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}

// One "Our Pets" card (spec sec 9.3): photo, name, species/breed, age, weight (only once one is recorded), and the
// health status ONLY when a person has set one -- nothing is shown that is not real data.
import { ChevronRight } from 'lucide-react';
import type { Animal } from './api';
import { AnimalPhoto } from './AnimalPhoto';
import { HEALTH_WORDS, summaryLine } from './words';

export function StatusChip({ status }: { status: NonNullable<Animal['health_status']> }) {
  const tone = status === 'HEALTHY' ? 'text-moss bg-moss-soft' : status === 'UNDER_TREATMENT' ? 'text-amber bg-gold-soft' : 'text-red bg-surface-2';
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${tone}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{HEALTH_WORDS[status]}</span>;
}

export function AnimalCard({ a }: { a: Animal }) {
  return (
    <a href={`#/animals/${a.id}`} className="group block overflow-hidden rounded-3xl border border-line bg-surface no-underline text-ink shadow-[var(--shadow)] transition-transform active:scale-[.99]">
      <AnimalPhoto path={a.photo} name={a.name} rounded="" className="aspect-[4/3] w-full" />
      <div className="flex items-end justify-between gap-3 px-5 pb-5 pt-4">
        <div className="min-w-0">
          <h3 className="name m-0 truncate text-[28px] leading-tight">{a.name}</h3>
          <p className="m-0 mt-1 truncate text-[15px] text-ink-2">{summaryLine(a)}</p>
          {a.status !== 'ACTIVE' && <p className="m-0 mt-1 text-[13px] text-ink-2">{a.status === 'DECEASED' ? 'Remembered' : 'Rehomed'}</p>}
          {a.health_status && <div className="mt-2"><StatusChip status={a.health_status} /></div>}
        </div>
        <ChevronRight aria-hidden className="mb-1 h-5 w-5 shrink-0 text-ink-2 transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} />
      </div>
    </a>
  );
}

// Home (spec sec 9.3): hero, Our Pets, Today, Coming Up, Inbox waiting. Sections with nothing real to show are hidden.
// With no animals yet, a single invitation to add the first one.
import { Inbox, Plus, Users } from 'lucide-react';
import { AgendaList } from './Agenda';
import type { Animal, Today } from './api';
import { AnimalCard } from './AnimalCard';
import { Hero } from './Hero';

function Waiting({ n }: { n: number }) {
  return (
    <a href="#/inbox" className="mt-10 flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-4 text-ink no-underline">
      <Inbox aria-hidden className="h-6 w-6 text-gold" strokeWidth={1.75} />
      <span className="font-semibold">{n === 1 ? '1 document to check' : `${n} documents to check`}</span>
    </a>
  );
}

export function Home({ animals, agenda = null, onRefresh }: { animals: Animal[]; agenda?: Today | null; onRefresh?: () => void }) {
  const active = animals.filter((a) => a.status === 'ACTIVE');
  const past = animals.filter((a) => a.status !== 'ACTIVE');
  return (
    <div>
      <Hero />
      <main className="mx-auto -mt-6 max-w-5xl px-4 pb-28 sm:px-6">
        {animals.length === 0 ? (
          <section className="relative rounded-3xl border border-line bg-surface p-6 text-center shadow-[var(--shadow)] sm:p-10">
            <h2 className="name m-0 text-3xl">Who shares your home?</h2>
            <p className="mx-auto mt-2 max-w-md text-ink-2">Add your first animal — a name and a species is enough to start. Everything else can come later.</p>
            <a href="#/add" className="btn btn-primary mt-6 no-underline"><Plus aria-hidden className="h-5 w-5" strokeWidth={2} />Add an animal</a>
          </section>
        ) : (
          <>
            {active.length > 0 ? (
              <section aria-labelledby="our-pets" className="relative">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <h2 id="our-pets" className="name m-0 text-[30px]">Our Pets</h2>
                  <a href="#/add" className="btn no-underline"><Plus aria-hidden className="h-5 w-5" strokeWidth={1.75} />Add</a>
                </div>
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {active.map((a) => <AnimalCard key={a.id} a={a} />)}
                </div>
              </section>
            ) : (
              // Every animal is remembered or rehomed: no empty "Our Pets" heading (independent review, 2026-10-07),
              // just a quiet way to add someone new.
              <div className="relative flex justify-end">
                <a href="#/add" className="btn no-underline"><Plus aria-hidden className="h-5 w-5" strokeWidth={1.75} />Add an animal</a>
              </div>
            )}
            {agenda && agenda.today.length > 0 && (
              <section aria-labelledby="today" className="mt-12">
                <h2 id="today" className="name m-0 mb-4 text-[26px]">Today</h2>
                <AgendaList items={agenda.today} onDone={onRefresh} done />
              </section>
            )}
            {agenda && agenda.coming_up.length > 0 && (
              <section aria-labelledby="coming-up" className="mt-12">
                <h2 id="coming-up" className="name m-0 mb-4 text-[26px]">Coming Up</h2>
                <AgendaList items={agenda.coming_up} />
              </section>
            )}
            {!!agenda?.inbox_waiting && <Waiting n={agenda.inbox_waiting} />}
            {past.length > 0 && (
              <section aria-labelledby="remembered" className="mt-12">
                <h2 id="remembered" className="name m-0 mb-4 text-2xl text-ink-2">Remembered and rehomed</h2>
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{past.map((a) => <AnimalCard key={a.id} a={a} />)}</div>
              </section>
            )}
          </>
        )}
        <p className="mt-12 text-center"><a href="#/household" className="inline-flex items-center gap-2 text-[15px] text-ink-2 no-underline"><Users aria-hidden className="h-4 w-4" strokeWidth={1.75} />Household</a></p>
      </main>
    </div>
  );
}

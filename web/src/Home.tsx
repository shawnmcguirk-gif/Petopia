// Home (spec sec 9.3): hero, then Our Pets. Sections with nothing real to show are hidden; Today, Coming Up and Inbox
// arrive with their slices (S5, S6). With no animals yet, a single invitation to add the first one.
import { Plus } from 'lucide-react';
import type { Animal } from './api';
import { AnimalCard } from './AnimalCard';
import { Hero } from './Hero';

export function Home({ animals }: { animals: Animal[] }) {
  const active = animals.filter((a) => a.status === 'ACTIVE');
  const past = animals.filter((a) => a.status !== 'ACTIVE');
  return (
    <div>
      <Hero />
      <main className="mx-auto -mt-6 max-w-5xl px-4 pb-16 sm:px-6">
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
            {past.length > 0 && (
              <section aria-labelledby="remembered" className="mt-12">
                <h2 id="remembered" className="name m-0 mb-4 text-2xl text-ink-2">Remembered and rehomed</h2>
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{past.map((a) => <AnimalCard key={a.id} a={a} />)}</div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

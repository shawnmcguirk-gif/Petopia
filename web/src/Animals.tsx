// Animals (spec sec 8.2): every animal of the household, active first; remembered and rehomed after.
import { Plus } from 'lucide-react';
import type { Animal } from './api';
import { AnimalCard } from './AnimalCard';

export function AnimalsScreen({ animals }: { animals: Animal[] }) {
  const active = animals.filter((a) => a.status === 'ACTIVE');
  const past = animals.filter((a) => a.status !== 'ACTIVE');
  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 pt-6 sm:px-6">
      <div className="mb-4 flex justify-end"><a href="#/add" className="btn no-underline"><Plus aria-hidden className="h-5 w-5" strokeWidth={1.75} />Add an animal</a></div>
      {active.length > 0 && <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{active.map((a) => <AnimalCard key={a.id} a={a} />)}</div>}
      {past.length > 0 && (
        <section aria-labelledby="past" className="mt-12">
          <h2 id="past" className="name m-0 mb-4 text-2xl text-ink-2">Remembered and rehomed</h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{past.map((a) => <AnimalCard key={a.id} a={a} />)}</div>
        </section>
      )}
      {animals.length === 0 && <p className="text-ink-2">No animals yet.</p>}
    </main>
  );
}

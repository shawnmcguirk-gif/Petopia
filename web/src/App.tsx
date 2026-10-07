// Petopia web shell (spec sec 8, 9; slice S2): Home, Add animal, an animal's Overview. Everything it shows comes from
// the engine; who may do what is decided there and only reflected here.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, get, type Animal, type Me } from './api';
import { AnimalForm } from './AnimalForm';
import { Hero } from './Hero';
import { Home } from './Home';
import { Overview } from './Overview';
import { TopBar } from './TopBar';
import { go, useRoute } from './route';

type Load = { state: 'loading' } | { state: 'error'; status: number; message: string } | { state: 'ready'; me: Me; animals: Animal[] };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Hero />
      <main className="mx-auto -mt-6 max-w-xl px-4 pb-16">
        <section className="relative rounded-3xl border border-line bg-surface p-6 text-center shadow-[var(--shadow)]">
          <h2 className="name m-0 text-2xl">{title}</h2>
          <div className="mt-2 text-ink-2">{children}</div>
        </section>
      </main>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const me = await get<Me>('api/me');
      const animals = me.household ? await get<Animal[]>('api/animals') : [];
      setLoad({ state: 'ready', me, animals });
    } catch (e) {
      setLoad({ state: 'error', status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : 'unknown' });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const put = (a: Animal) =>
    setLoad((l) => (l.state === 'ready' ? { ...l, animals: l.animals.some((x) => x.id === a.id) ? l.animals.map((x) => (x.id === a.id ? a : x)) : [...l.animals, a] } : l));

  if (load.state === 'loading') return <div aria-busy="true"><Hero /></div>;
  if (load.state === 'error') {
    if (load.status === 401) return <Notice title="Open Petopia from Synapse">This device isn’t signed in here. Open Petopia from the Synapse home screen.</Notice>;
    if (load.status === 403) return <Notice title="Petopia isn’t switched on for you">Ask whoever runs Synapse at home to give you access.</Notice>;
    return <Notice title="Petopia can’t be reached">Please try again in a moment. <button className="btn mt-4" onClick={() => { setLoad({ state: 'loading' }); void refresh(); }}>Try again</button></Notice>;
  }
  if (!load.me.household) return <Notice title="Not part of the household yet">You’re signed in as {load.me.member}, but Petopia hasn’t been shared with you yet.</Notice>;

  if (route.name === 'add') return <><TopBar title="Add an animal" /><AnimalForm onSaved={put} /></>;
  if (route.name === 'animal' || route.name === 'edit') {
    const a = load.animals.find((x) => x.id === route.id);
    if (!a) return <><TopBar title="Not found" /><p className="mx-auto max-w-xl px-4 pt-8 text-ink-2">That animal isn’t in this household.</p></>;
    if (route.name === 'edit') return <><TopBar title={`Edit ${a.name}`} back={`#/animals/${a.id}`} /><AnimalForm existing={a} onSaved={(n) => { put(n); go(`/animals/${n.id}`); }} /></>;
    return <><TopBar title={a.name} /><Overview a={a} onChange={put} /></>;
  }
  return <Home animals={load.animals} />;
}

// About pages (D2 spec sec 8): what a kind of animal is like, from a researched page. Slice A1 shows RESEARCHED pages only.
// Everything shown comes from the engine, which has already put it through the safety guard (withheld lines arrive as such).
import { ChevronDown, X } from 'lucide-react';
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { get, type AboutKind, type Animal, type SpeciesAbout } from './api';
import { niceDate } from './format';

/** Fixed text, never from data (spec sec 2). */
export const TOP_LINE = 'General information about this kind of animal — not about your animal, and not veterinary advice. For a health worry, ring your vet.';

type Page = Extract<SpeciesAbout, { state: 'PAGE' }>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Only a page of the shape we draw: anything else (an old or broken answer) is treated as "no page", never half-drawn. */
export function isPage(r: unknown): r is Page {
  if (!isObj(r) || r.state !== 'PAGE' || !isObj(r.species) || typeof r.species.common_name !== 'string' || !isObj(r.headings) || !isObj(r.sections)) return false;
  if (typeof r.checked_on !== 'string' || typeof r.source_count !== 'number') return false;
  return Object.values(r.sections).every((s) => isObj(s) && Array.isArray(s.sources) && Array.isArray(s.statements)
    && s.statements.every((t) => isObj(t) && typeof t.text === 'string')
    && s.sources.every((x) => isObj(x) && typeof x.url === 'string' && typeof x.title === 'string' && typeof x.publisher === 'string' && typeof x.checked_on === 'string'));
}

export const badgeText = (p: Page): string => `Researched · checked ${niceDate(p.checked_on)} · ${p.source_count} ${p.source_count === 1 ? 'source' : 'sources'}`;

export function Badge({ page }: { page: Page }) {
  return <span className="inline-flex items-center rounded-full bg-moss-soft px-2.5 py-0.5 text-[12px] font-semibold text-moss">{badgeText(page)}</span>;
}

/** The whole page: heading, fixed line, badge, collapsible sections with their sources, footer. */
export function AboutBody({ page }: { page: Page }) {
  const keys = Object.keys(page.sections);
  return (
    <article className="space-y-5">
      <header>
        <h2 className="name m-0 text-[32px] leading-[1.1]">About: {page.species.common_name}</h2>
        {page.species.scientific_name && <p className="m-0 mt-1 italic text-ink-2">{page.species.scientific_name}</p>}
        <div className="mt-3"><Badge page={page} /></div>
      </header>
      <p className="m-0 rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-[15px]">{TOP_LINE}</p>
      {keys.map((k, i) => {
        const s = page.sections[k]!;
        return (
          <details key={k} open={i < 2} className="group rounded-2xl border border-line bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 text-[17px] font-semibold [&::-webkit-details-marker]:hidden">
              {page.headings[k] ?? k}
              <ChevronDown aria-hidden className="h-5 w-5 shrink-0 text-ink-2 transition-transform group-open:rotate-180" strokeWidth={1.75} />
            </summary>
            <div className="px-4 pb-4">
              <ul className="m-0 list-disc space-y-2 pl-5">
                {s.statements.map((t, j) => <li key={j} className={t.withheld ? 'italic text-ink-2' : ''}>{t.text}</li>)}
              </ul>
              {s.sources.length > 0 && (
                <details className="mt-3 text-[14px]">
                  <summary className="cursor-pointer text-ink-2">Sources ({s.sources.length})</summary>
                  <ul className="m-0 mt-2 list-none space-y-1.5 p-0">
                    {s.sources.map((x, n) => (
                      <li key={`${n}-${x.url}`}>
                        <a href={x.url} target="_blank" rel="noopener noreferrer">{x.title}</a>
                        <span className="text-ink-2"> — {x.publisher}, checked {niceDate(x.checked_on)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </details>
        );
      })}
      <footer className="text-[13px] text-ink-2">
        {page.reviewed_by ? `Read by ${page.reviewed_by}.` : 'Researched by Claude, from the sources listed.'} Not reviewed by a vet.
      </footer>
    </article>
  );
}

type Load = { state: 'loading' } | { state: 'none' } | { state: 'error' } | { state: 'page'; page: Page };

function useSpeciesPage(id: number): Load {
  const [l, setL] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setL({ state: 'loading' });
    get<SpeciesAbout>(`api/about/species/${id}`).then(
      (r) => { if (live) setL(isPage(r) ? { state: 'page', page: r } : isObj(r) && r.state === 'NONE' ? { state: 'none' } : { state: 'error' }); },
      () => { if (live) setL({ state: 'error' }); },
    );
    return () => { live = false; };
  }, [id]);
  return l;
}

/** The page at #/about/species/:id. */
export function AboutPage({ speciesId }: { speciesId: number }) {
  const l = useSpeciesPage(speciesId);
  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-5 sm:px-6">
      {l.state === 'loading' && <p aria-busy="true" className="text-ink-2">Loading…</p>}
      {l.state === 'none' && <p className="text-ink-2">There isn’t a page for this kind of animal yet.</p>}
      {l.state === 'error' && <p className="text-ink-2">The page couldn’t be loaded. Please try again in a moment.</p>}
      {l.state === 'page' && <AboutBody page={l.page} />}
    </main>
  );
}

/** The same page in a sheet over the Add animal form, so nothing typed there is lost. */
export function AboutSheet({ speciesId, onClose }: { speciesId: number; onClose: () => void }) {
  const l = useSpeciesPage(speciesId);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Move focus into the sheet, and give it back to whatever opened it when the sheet closes.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => before?.focus();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="About this kind of animal" className="outline-none max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-bg p-5 shadow-[var(--shadow)] sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex justify-end">
          <button type="button" aria-label="Close" className="inline-flex h-10 w-10 items-center justify-center rounded-full border-0 bg-transparent text-ink-2 hover:bg-surface-2" onClick={onClose}>
            <X aria-hidden className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
        {l.state === 'loading' && <p aria-busy="true" className="text-ink-2">Loading…</p>}
        {l.state === 'none' && <p className="text-ink-2">There isn’t a page for this kind of animal yet.</p>}
        {l.state === 'error' && <p className="text-ink-2">The page couldn’t be loaded. Please try again in a moment.</p>}
        {l.state === 'page' && <AboutBody page={l.page} />}
      </div>
    </div>
  );
}

type CardState = { state: 'loading' } | { state: 'hidden' } | { state: 'page'; page: Page } | { state: 'nopage'; kind: string };

/** The card is an extra on the Overview: if it ever fails to draw, it disappears rather than taking the Overview with it. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.warn('About card failed to draw', e, info.componentStack); }
  render() { return this.state.failed ? null : this.props.children; }
}
export const AboutCard = ({ a }: { a: Animal }) => <Quiet><AboutCardInner a={a} /></Quiet>;

/** The About card on an animal's Overview (spec sec 8.2). A1: a researched page, or the plain "no page yet" sentence for a typed kind. */
function AboutCardInner({ a }: { a: Animal }) {
  const typedRaw = a.module === 'other' ? a.ext?.species_name : undefined;
  const typed = typeof typedRaw === 'string' && typedRaw.trim() ? typedRaw.trim() : null;
  const [c, setC] = useState<CardState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    const set = (x: CardState) => { if (live) setC(x); };
    (async () => {
      try {
        let id = a.species_id;
        if (typed) {
          const k = await get<AboutKind>(`api/about/kind?name=${encodeURIComponent(typed)}`);
          if (k?.tier !== 'SPECIES' || !k.species) return set({ state: 'nopage', kind: typed });
          id = k.species.id;
        }
        const p = await get<SpeciesAbout>(`api/about/species/${id}`);
        if (isPage(p)) set({ state: 'page', page: p });
        else set(typed ? { state: 'nopage', kind: typed } : { state: 'hidden' });
      } catch {
        set({ state: 'hidden' }); // the card is an extra: without it the Overview still works
      }
    })();
    return () => { live = false; };
  }, [a.species_id, typed]);

  if (c.state === 'loading' || c.state === 'hidden') return null;
  if (c.state === 'nopage') {
    return <section aria-label="About this kind of animal" className="mt-8"><p className="m-0 rounded-2xl border border-line bg-surface px-4 py-3.5 text-ink-2">We don’t have a page for {c.kind} yet.</p></section>;
  }
  const first = c.page.sections.summary?.statements[0];
  return (
    <section aria-label="About this kind of animal" className="mt-8 rounded-2xl border border-line bg-surface p-4">
      <h3 className="m-0 text-[17px] font-semibold">About: {c.page.species.common_name}</h3>
      <div className="mt-2"><Badge page={c.page} /></div>
      {first && <p className={`m-0 mt-3 ${first.withheld ? 'italic text-ink-2' : ''}`}>{first.text}</p>}
      <a href={`#/about/species/${c.page.species.id}`} className="btn mt-3 no-underline">Read more</a>
    </section>
  );
}

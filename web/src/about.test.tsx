// D2 About pages in the web app (slice A1): the card on an animal's Overview, the page, the sheet over Add animal, the route.
// Fictional fixtures: a rabbit "Clover", a tarantula "Hairy", a robin page.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Animal, SpeciesAbout, SpeciesOption } from './api';
import { AboutBody, AboutCard, AboutPage, AboutSheet, badgeText, isPage, TOP_LINE } from './About';
import { AnimalForm } from './AnimalForm';
import { parseRoute } from './route';

const SRC = (n: number) => ({ title: `Guide ${n}`, publisher: `Publisher ${n}`, url: `https://example.org/${n}`, checked_on: '2026-10-05' });
type Page = Extract<SpeciesAbout, { state: 'PAGE' }>;
function page(over: Partial<Page> = {}, name = 'Rabbit', id = 3): Page {
  return {
    state: 'PAGE', species: { id, common_name: name, scientific_name: 'Oryctolagus cuniculus', domain: 'PET' }, version: 1, checked_on: '2026-10-05',
    written_by: 'a cold research session', reviewed_by: null, source_count: 2,
    headings: { summary: 'What it is', characteristics: 'Appearance and character', habits: 'Habits and behaviour', housing: 'Housing' },
    sections: {
      summary: { statements: [{ text: 'A small, social animal that lives in groups.', withheld: false }], sources: [SRC(1)] },
      characteristics: { statements: [{ text: 'Long ears and strong back legs.', withheld: false }], sources: [SRC(1), SRC(2)] },
      habits: { statements: [{ text: 'Most active at dawn and dusk.', withheld: false }, { text: 'This point was withheld because it read like advice. Ask your vet.', withheld: true }], sources: [SRC(2)] },
    },
    ...over,
  };
}
const clover = { id: 9, species_id: 3, name: 'Clover', species: 'Rabbit', module: 'rabbit', ext: {} } as unknown as Animal;
const hairy = { id: 10, species_id: 99, name: 'Hairy', species: 'Tarantula', module: 'other', ext: { species_name: 'Tarantula' } } as unknown as Animal;
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

function stub(routes: Record<string, () => Promise<Response>>) {
  const f = vi.fn((u: string) => (routes[u] ? routes[u]() : reply(404, { error: 'no' })));
  vi.stubGlobal('fetch', f);
  return f;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('badge text', () => {
  it('says researched, the checked date in short form, and the number of sources', () => {
    expect(badgeText(page())).toBe('Researched · checked 5 Oct 2026 · 2 sources');
    expect(badgeText(page({ source_count: 1 }))).toBe('Researched · checked 5 Oct 2026 · 1 source');
  });
});

describe('AboutCard on an Overview', () => {
  it('a species with a page: heading, badge, the first summary statement, and Read more', async () => {
    stub({ 'api/about/species/3': () => reply(200, page()) });
    render(<AboutCard a={clover} />);
    expect(await screen.findByRole('heading', { name: 'About: Rabbit' })).toBeTruthy();
    expect(screen.getByText('Researched · checked 5 Oct 2026 · 2 sources')).toBeTruthy();
    expect(screen.getByText('A small, social animal that lives in groups.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read more' }).getAttribute('href')).toBe('#/about/species/3');
  });

  it('a species with no page yet shows no card at all (no "coming soon")', async () => {
    const f = stub({ 'api/about/species/3': () => reply(200, { state: 'NONE' }) });
    const { container } = render(<AboutCard a={clover} />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('shows nothing, and does not throw, when the page cannot be loaded', async () => {
    const f = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', f);
    const { container } = render(<AboutCard a={clover} />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('an "Other animal" with a typed kind nobody has a page for says so, in one sentence, with no button', async () => {
    stub({ 'api/about/kind?name=Tarantula': () => reply(200, { tier: 'NONE', can_write: true }) });
    render(<AboutCard a={hairy} />);
    expect(await screen.findByText('We don’t have a page for Tarantula yet.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('an "Other animal" whose typed kind is a wild species shows that species\' page', async () => {
    const robin = { ...hairy, name: 'Rob', species: 'Robin', ext: { species_name: 'Robin' } } as Animal;
    stub({
      'api/about/kind?name=Robin': () => reply(200, { tier: 'SPECIES', wild: true, species: { id: 20, common_name: 'Robin', domain: 'WILD', has_page: true }, can_write: false }),
      'api/about/species/20': () => reply(200, page({ species: { id: 20, common_name: 'Robin', scientific_name: null, domain: 'WILD' } })),
    });
    render(<AboutCard a={robin} />);
    expect(await screen.findByRole('heading', { name: 'About: Robin' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read more' }).getAttribute('href')).toBe('#/about/species/20');
  });

  it('a typed wild kind with no page yet gets the same one sentence', async () => {
    const robin = { ...hairy, species: 'Robin', ext: { species_name: 'Robin' } } as Animal;
    stub({
      'api/about/kind?name=Robin': () => reply(200, { tier: 'SPECIES', wild: true, species: { id: 20, common_name: 'Robin', domain: 'WILD', has_page: false }, can_write: false }),
      'api/about/species/20': () => reply(200, { state: 'NONE' }),
    });
    render(<AboutCard a={robin} />);
    expect(await screen.findByText('We don’t have a page for Robin yet.')).toBeTruthy();
  });
});

describe('the About page', () => {
  it('has the fixed line, the heading, the scientific name, sections with their own headings, and a Sources drawer on each', () => {
    render(<AboutBody page={page()} />);
    expect(screen.getByRole('heading', { name: 'About: Rabbit' })).toBeTruthy();
    expect(screen.getByText(TOP_LINE)).toBeTruthy();
    expect(screen.getByText('Oryctolagus cuniculus')).toBeTruthy();
    for (const h of ['What it is', 'Appearance and character', 'Habits and behaviour']) expect(screen.getByText(h)).toBeTruthy();
    expect(screen.getAllByText('Sources (1)')).toHaveLength(2); // summary and habits cite one source each
    expect(screen.getAllByText('Sources (2)')).toHaveLength(1);
    const link = screen.getAllByRole('link', { name: 'Guide 1' })[0]!;
    expect(link.getAttribute('href')).toBe('https://example.org/1');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('the first two sections are open, the rest closed', () => {
    const { container } = render(<AboutBody page={page()} />);
    const sections = [...container.querySelectorAll('article > details')] as HTMLDetailsElement[];
    expect(sections.map((d) => d.open)).toEqual([true, true, false]);
  });

  it('a withheld line is shown as withheld, in its own words', () => {
    render(<AboutBody page={page()} />);
    expect(screen.getByText('This point was withheld because it read like advice. Ask your vet.')).toBeTruthy();
  });

  it('the footer says who read it once someone has, and never claims a vet did', () => {
    const { rerender } = render(<AboutBody page={page()} />);
    expect(screen.getByText(/Researched by Claude, from the sources listed\. Not reviewed by a vet\./)).toBeTruthy();
    rerender(<AboutBody page={page({ reviewed_by: 'ryan' })} />);
    expect(screen.getByText(/Read by ryan\. Not reviewed by a vet\./)).toBeTruthy();
    expect(screen.queryByText(/Researched by Claude/)).toBeNull();
  });

  it('a wild animal\'s housing section is headed "Habitat" (the engine sends the heading)', () => {
    render(<AboutBody page={page({ headings: { summary: 'What it is', housing: 'Habitat' }, sections: { summary: page().sections.summary!, housing: { statements: [{ text: 'Woods, hedges and gardens.', withheld: false }], sources: [SRC(1)] } } })} />);
    expect(screen.getByText('Habitat')).toBeTruthy();
  });

  it('the route loads a page, says plainly when there is none, and when it cannot load', async () => {
    stub({ 'api/about/species/3': () => reply(200, page()), 'api/about/species/4': () => reply(200, { state: 'NONE' }) });
    const a = render(<AboutPage speciesId={3} />);
    expect(await screen.findByRole('heading', { name: 'About: Rabbit' })).toBeTruthy();
    a.unmount();
    render(<AboutPage speciesId={4} />);
    expect(await screen.findByText('There isn’t a page for this kind of animal yet.')).toBeTruthy();
    cleanup();
    render(<AboutPage speciesId={5} />);
    expect(await screen.findByText(/couldn’t be loaded/)).toBeTruthy();
  });
});

describe('an answer that is not the shape we draw', () => {
  it('isPage accepts a real page and refuses anything half-formed', () => {
    expect(isPage(page())).toBe(true);
    expect(isPage(null)).toBe(false);
    expect(isPage({ state: 'PAGE' })).toBe(false);
    const noSources = page();
    (noSources.sections.summary as unknown as Record<string, unknown>).sources = undefined;
    expect(isPage(noSources)).toBe(false);
    const badLink = page();
    (badLink.sections.summary!.sources[0] as unknown as Record<string, unknown>).url = 7;
    expect(isPage(badLink)).toBe(false);
  });

  it('the card disappears quietly instead of drawing half a page', async () => {
    const broken = page();
    (broken.sections.summary as unknown as Record<string, unknown>).statements = 'oops';
    const f = stub({ 'api/about/species/3': () => reply(200, broken) });
    const { container } = render(<AboutCard a={clover} />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
  });

  it('the page route says it could not be loaded (not "no page") for a broken answer', async () => {
    stub({ 'api/about/species/3': () => reply(200, { state: 'PAGE', species: {} }) });
    render(<AboutPage speciesId={3} />);
    expect(await screen.findByText(/couldn’t be loaded/)).toBeTruthy();
  });

  it('the sheet tells "no page" and "could not load" apart, and takes focus when it opens', async () => {
    stub({ 'api/about/species/4': () => reply(200, { state: 'NONE' }) });
    const a = render(<AboutSheet speciesId={4} onClose={() => undefined} />);
    expect(await screen.findByText('There isn’t a page for this kind of animal yet.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    a.unmount();
    render(<AboutSheet speciesId={5} onClose={() => undefined} />);
    expect(await screen.findByText(/couldn’t be loaded/)).toBeTruthy();
  });

  it('two sources with the same link in one section both draw (no duplicate-key trouble)', () => {
    const p = page();
    p.sections.summary!.sources = [SRC(1), SRC(1)];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<AboutBody page={p} />);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('route', () => {
  it('parses #/about/species/:id and nothing looser', () => {
    expect(parseRoute('#/about/species/12')).toEqual({ name: 'about', species: 12 });
    expect(parseRoute('#/about/species/x')).toEqual({ name: 'home' });
    expect(parseRoute('#/about/species/12/extra')).toEqual({ name: 'home' });
    expect(parseRoute('#/about/kind/12')).toEqual({ name: 'home' }); // drafts arrive in a later slice
  });
});

describe('Add animal: About link and hint', () => {
  const SPECIES: SpeciesOption[] = [
    { id: 1, name: 'Dog', group: 'DOG', module: 'dog' }, { id: 2, name: 'Cat', group: 'CAT', module: 'cat' },
    { id: 3, name: 'Rabbit', group: 'MAMMAL', module: 'rabbit', has_about: true }, { id: 4, name: 'Budgerigar', group: 'BIRD', module: 'cage_bird', has_about: false },
    { id: 6, name: 'Other animal', group: 'OTHER', module: 'other' },
  ];
  const routes = { 'api/species': () => reply(200, SPECIES), 'api/about/species/3': () => reply(200, page()) };

  it('a species with a page offers "About Rabbit", which opens the page in a sheet over the form and closes again', async () => {
    stub(routes);
    render(<AnimalForm onSaved={() => undefined} />);
    const pick = (await screen.findByLabelText('Or another kind of animal')) as HTMLSelectElement;
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull();
    fireEvent.change(pick, { target: { value: 'Budgerigar' } });
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull(); // no page, no link
    fireEvent.change(pick, { target: { value: 'Rabbit' } });
    fireEvent.click(screen.getByRole('button', { name: 'About Rabbit' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('About: Rabbit');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clover' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Clover'); // nothing typed was lost
    expect((screen.getByLabelText('Or another kind of animal') as HTMLSelectElement).value).toBe('Rabbit');
  });

  it('Escape closes the sheet', async () => {
    stub(routes);
    render(<AnimalForm onSaved={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Or another kind of animal'), { target: { value: 'Rabbit' } });
    fireEvent.click(screen.getByRole('button', { name: 'About Rabbit' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the typed-kind box says it wants the kind of animal, not its name', async () => {
    stub(routes);
    render(<AnimalForm onSaved={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Or another kind of animal'), { target: { value: 'Other animal' } });
    const input = screen.getByLabelText('What kind of animal is it?');
    expect(screen.getByText(/The kind of animal, not its name/)).toBeTruthy();
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
  });
});

// The S2 web shell: real data only, empty sections hidden, fail-closed screens. Fictional fixture: Biscuit, a cat.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Animal } from './api';
import { AnimalCard } from './AnimalCard';
import { App } from './App';
import { Home } from './Home';
import { parseRoute } from './route';
import { summaryLine } from './words';

const biscuit: Animal = {
  id: 7, name: 'Biscuit', nickname: null, species: 'Cat', module: 'cat', breed: 'Domestic shorthair', sex: 'UNKNOWN', neuter_status: 'UNKNOWN',
  colour_markings: null, born: '2018', born_precision: 'YEAR', age: { years: 8, months: 0, text: 'about 8 years', approximate: true }, acquired: null,
  microchip: null, habitat: 'Home', kind: 'PET', status: 'ACTIVE', health_status: null, latest_weight: null, photo: null, my_role: 'OWNER', can: ['VIEW'],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('summaryLine', () => {
  it('breed · age, and weight only once one is recorded', () => {
    expect(summaryLine(biscuit)).toBe('Domestic shorthair · about 8 years');
    expect(summaryLine({ ...biscuit, latest_weight: { kg: '4.200', on: '2026-10-01' } })).toBe('Domestic shorthair · about 8 years · 4.2 kg');
  });
  it('falls back to the species, and leaves out an unknown age', () => {
    expect(summaryLine({ ...biscuit, breed: null, age: null })).toBe('Cat');
  });
});

describe('AnimalCard', () => {
  it('shows no health status unless a person has set one (never invented)', () => {
    render(<AnimalCard a={biscuit} />);
    expect(screen.getByRole('heading', { name: 'Biscuit' })).toBeTruthy();
    expect(screen.getByText('Domestic shorthair · about 8 years')).toBeTruthy();
    expect(screen.queryByText('Healthy')).toBeNull();
    expect(screen.getByRole('img', { name: 'No photo of Biscuit yet' })).toBeTruthy();
    cleanup();
    render(<AnimalCard a={{ ...biscuit, health_status: 'HEALTHY' }} />);
    expect(screen.getByText('Healthy')).toBeTruthy();
  });
  it('links to the animal with a relative hash route', () => {
    render(<AnimalCard a={biscuit} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('#/animals/7');
  });
});

describe('Home', () => {
  it('with no animals: no empty "Our Pets" section, one invitation to add', () => {
    render(<Home animals={[]} />);
    expect(screen.queryByRole('heading', { name: 'Our Pets' })).toBeNull();
    expect(screen.getByRole('link', { name: /add an animal/i }).getAttribute('href')).toBe('#/add');
  });
  it('with animals: Our Pets, and no "Remembered" section unless someone is', () => {
    render(<Home animals={[biscuit]} />);
    expect(screen.getByRole('heading', { name: 'Our Pets' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /remembered/i })).toBeNull();
  });
  it('the hero uses relative image paths (works under /petopia/)', () => {
    const { container } = render(<Home animals={[]} />);
    for (const el of container.querySelectorAll('img, source')) {
      const src = el.getAttribute('src') ?? el.getAttribute('srcset') ?? '';
      expect(src.startsWith('./')).toBe(true);
    }
  });
});

describe('App', () => {
  const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  it('no device token -> asks to open Petopia from Synapse; API paths are relative', async () => {
    const f = vi.fn((u: string) => (u ? reply(401, { error: 'missing device token' }) : reply(500, {})));
    vi.stubGlobal('fetch', f);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /open petopia from synapse/i })).toBeTruthy());
    expect(f.mock.calls[0]![0]).toBe('api/me');
  });
  it('signed in without a household grant -> says so, and does not ask for animals', async () => {
    const f = vi.fn((u: string) => (u ? reply(200, { member: 'Alex', household: null }) : reply(500, {})));
    vi.stubGlobal('fetch', f);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /not part of the household/i })).toBeTruthy());
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('signed in with a household -> Our Pets with the animals', async () => {
    vi.stubGlobal('fetch', vi.fn((u: string) => (u === 'api/me' ? reply(200, { member: 'Alex', household: { id: 1 } }) : reply(200, [biscuit]))));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Biscuit' })).toBeTruthy());
  });
});

describe('routes', () => {
  it('parses hash routes', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/add')).toEqual({ name: 'add' });
    expect(parseRoute('#/animals/12')).toEqual({ name: 'animal', id: 12 });
    expect(parseRoute('#/animals/12/edit')).toEqual({ name: 'edit', id: 12 });
    expect(parseRoute('#/nonsense')).toEqual({ name: 'home' });
  });
});

// Add animal for any kind of animal (Ryan, 2026-10-08). Fictional fixtures: a rabbit "Clover", a tarantula "Hairy".
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Animal, SpeciesOption } from './api';
import { AnimalForm } from './AnimalForm';

const SPECIES: SpeciesOption[] = [
  { id: 1, name: 'Dog', group: 'DOG', module: 'dog' }, { id: 2, name: 'Cat', group: 'CAT', module: 'cat' },
  { id: 3, name: 'Rabbit', group: 'MAMMAL', module: 'small_mammal' }, { id: 4, name: 'Budgerigar', group: 'BIRD', module: 'cage_bird' },
  { id: 5, name: 'Goldfish', group: 'FISH', module: 'aquarium_fish' }, { id: 6, name: 'Other animal', group: 'OTHER', module: 'other' },
];
const saved = { id: 9, name: 'Clover' } as Animal;
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

function stub(speciesReply: () => Promise<Response> = () => reply(200, SPECIES)) {
  const f = vi.fn((u: string, init?: RequestInit) => (u === 'api/species' ? speciesReply() : init?.method === 'POST' ? reply(201, saved) : reply(500, {})));
  vi.stubGlobal('fetch', f);
  return f;
}
const posted = (f: ReturnType<typeof stub>) => JSON.parse((f.mock.calls.find((c) => c[0] === 'api/animals')![1] as RequestInit).body as string) as Record<string, unknown>;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AnimalForm: any kind of animal', () => {
  it('lists the other kinds of animal under their groups, and adds a rabbit by name', async () => {
    const f = stub();
    render(<AnimalForm onSaved={() => undefined} />);
    const pick = (await screen.findByLabelText('Or another kind of animal')) as HTMLSelectElement;
    expect([...pick.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Mammals', 'Birds', 'Fish']); // groups with nothing in them are left out
    expect([...pick.options].map((o) => o.text)).toContain('Rabbit');
    expect([...pick.options].map((o) => o.text)).not.toContain('Dog'); // Dog and Cat have their own buttons
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clover' } });
    fireEvent.change(pick, { target: { value: 'Rabbit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add animal' }));
    await waitFor(() => expect(posted(f)).toMatchObject({ name: 'Clover', species: 'Rabbit' }));
    expect(posted(f).ext).toBeUndefined();
  });

  it('"Something else" asks what it is, will not save without it, and sends it as the animal\'s own words', async () => {
    const f = stub();
    render(<AnimalForm onSaved={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Or another kind of animal'), { target: { value: 'Other animal' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hairy' } });
    const add = screen.getByRole('button', { name: 'Add animal' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What kind of animal is it?'), { target: { value: ' Tarantula ' } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(posted(f)).toMatchObject({ name: 'Hairy', species: 'Other animal', ext: { species_name: 'Tarantula' } }));
  });

  it('switching from "Something else" back to Dog sends no typed kind', async () => {
    const f = stub();
    render(<AnimalForm onSaved={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Or another kind of animal'), { target: { value: 'Other animal' } });
    fireEvent.change(screen.getByLabelText('What kind of animal is it?'), { target: { value: 'Tarantula' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dog' }));
    expect(screen.queryByLabelText('What kind of animal is it?')).toBeNull();
    expect((screen.getByLabelText('Or another kind of animal') as HTMLSelectElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Banoffee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add animal' }));
    await waitFor(() => expect(posted(f)).toMatchObject({ name: 'Banoffee', species: 'Dog' }));
    expect(posted(f).ext).toBeUndefined();
  });

  it('Dog and Cat stay one tap, and the breed hint follows the species', async () => {
    const f = stub();
    render(<AnimalForm onSaved={() => undefined} />);
    await screen.findByLabelText('Or another kind of animal');
    fireEvent.click(screen.getByRole('button', { name: 'Cat' }));
    expect((screen.getByLabelText(/Breed/) as HTMLInputElement).placeholder).toBe('e.g. Domestic shorthair');
    fireEvent.click(screen.getByRole('button', { name: 'Dog' }));
    expect((screen.getByLabelText(/Breed/) as HTMLInputElement).placeholder).toBe('e.g. Shih Tzu');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Banoffee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add animal' }));
    await waitFor(() => expect(posted(f)).toMatchObject({ name: 'Banoffee', species: 'Dog' }));
  });

  it('if the species list cannot load, Dog, Cat and "another kind" are still there', async () => {
    const f = stub(() => reply(500, { error: 'down' }));
    render(<AnimalForm onSaved={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Dog' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cat' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Another kind of animal' }));
    expect(screen.getByLabelText('What kind of animal is it?')).toBeTruthy();
    expect(f).toHaveBeenCalledWith('api/species', expect.anything());
  });
});

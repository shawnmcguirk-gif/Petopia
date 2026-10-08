// S3 / S4 web: real data only, empty sections hidden, the weight question asked (not saved silently), badges shown,
// role-dependent controls, and the review fix for Home. Fictional fixture: Biscuit, a cat.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Animal, Health, TimelineEntry } from './api';
import { AnimalCard } from './AnimalCard';
import { changeText, niceDate, todayIso } from './format';
import { Glance } from './Glance';
import { HealthTab } from './HealthTab';
import { Home } from './Home';
import { TimelineTab } from './TimelineTab';
import { WeightForm } from './WeightSection';

const biscuit: Animal = {
  id: 7, species_id: 2, name: 'Biscuit', nickname: null, species: 'Cat', module: 'cat', breed: 'Domestic shorthair', sex: 'UNKNOWN', neuter_status: 'UNKNOWN',
  colour_markings: null, born: '2018', born_precision: 'YEAR', age: { years: 8, months: 0, text: 'about 8 years', approximate: true }, acquired: null,
  microchip: null, habitat: 'Home', kind: 'PET', status: 'ACTIVE', health_status: null, latest_weight: null, current_food: null, current_medication: [],
  vet: null, emergency_contact: null, photo: null, my_role: 'OWNER', can: ['VIEW', 'ADD_MEDIA', 'PROPOSE_RECORDS', 'CONFIRM_RECORDS', 'MANAGE_CARE', 'EDIT_PROFILE'],
};
const viewer: Animal = { ...biscuit, my_role: 'VIEWER', can: ['VIEW'] };
const family: Animal = { ...biscuit, my_role: 'FAMILY', can: ['VIEW', 'ADD_MEDIA', 'PROPOSE_RECORDS'] };
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const emptyHealth: Health = { records: { vet_visit: [], vaccination: [], treatment: [], condition: [], allergy: [], procedure: [], lab_result: [] }, medications: { current: [], medicines: [] }, measurements: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('format', () => {
  it('vague dates stay vague; change words', () => {
    expect(niceDate('2025')).toBe('2025');
    expect(niceDate('2025-10')).toBe('Oct 2025');
    expect(niceDate('2025-10-03')).toBe('3 Oct 2025');
    expect(changeText('+0.2', 'kg')).toBe('+0.2 kg');
    expect(changeText('-0.25', 'kg')).toBe('−0.25 kg');
    expect(changeText('0', 'kg')).toBe('no change');
    expect(changeText(null, 'kg')).toBeNull();
  });
});

describe('Home (review fix)', () => {
  it('when every animal is remembered or rehomed there is no empty "Our Pets" heading', () => {
    render(<Home animals={[{ ...biscuit, status: 'DECEASED' }]} />);
    expect(screen.queryByRole('heading', { name: 'Our Pets' })).toBeNull();
    expect(screen.getByRole('heading', { name: /remembered and rehomed/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /add an animal/i })).toBeTruthy();
  });
  it('the card shows a weight only from a recorded one', () => {
    render(<AnimalCard a={{ ...biscuit, latest_weight: { kg: '4.3', on: '2026-10-01', change_kg: '+0.1' } }} />);
    expect(screen.getByText('Domestic shorthair · about 8 years · 4.3 kg')).toBeTruthy();
  });
});

describe('Overview at a glance', () => {
  it('hidden entirely when nothing is recorded (no invented values)', () => {
    render(<Glance a={viewer} onChange={() => undefined} />);
    expect(screen.queryByText(/at a glance/i)).toBeNull();
    expect(screen.queryByText(/kg/)).toBeNull();
  });
  it('current food, weight and medication when they exist', () => {
    vi.stubGlobal('fetch', vi.fn(() => json(200, [])));
    render(<Glance onChange={() => undefined} a={{
      ...viewer, latest_weight: { kg: '4.3', on: '2026-10-01', change_kg: '-0.1' },
      current_food: { brand: 'Acme', product: 'Senior', food_type: 'WET', portion_amount: '60', portion_unit: 'g', times: ['08:00'], from_on: '2026-10-01' },
      current_medication: [{ medication_id: 1, product_name: 'Examplecillin', dose: '1 tablet', frequency: 'twice a day', since: '2026-09-20' }],
    }} />);
    expect(screen.getByText('4.3 kg')).toBeTruthy();
    expect(screen.getByText(/−0\.1 kg since last/)).toBeTruthy();
    expect(screen.getByText('Acme Senior')).toBeTruthy();
    expect(screen.getByText('Examplecillin')).toBeTruthy();
  });
});

describe('WeightForm: the plausibility question (S3 acceptance)', () => {
  it('61 asks "did you mean 6.1?"; nothing more is sent until the person answers; "yes" sends confirm_unusual', async () => {
    const f = vi.fn((_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { confirm_unusual?: boolean };
      return b.confirm_unusual ? json(201, []) : json(409, { error: '61 kg is very different from the last weight (6.1 kg on 2026-10-01). Did you mean 6.1 kg?', needs_confirmation: true, suggestion: { value: '6.1', unit: 'kg' } });
    });
    vi.stubGlobal('fetch', f);
    const saved = vi.fn();
    render(<WeightForm a={biscuit} onClose={() => undefined} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '61' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weight' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(screen.getByText(/did you mean 6\.1 kg/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use 6.1 kg' })).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, 61 kg is right' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toMatchObject({ value: '61', unit: 'kg', confirm_unusual: true });
  });
});

describe('HealthTab', () => {
  const withRecords: Health = {
    ...emptyHealth,
    records: {
      ...emptyHealth.records,
      vaccination: [{ id: 3, kind: 'vaccination', status: 'CONFIRMED', badge: { code: 'VET_RECORD', text: 'Vet record' }, by: 'Alex', confirmed_by: 'Alex', supersedes_id: null, created_at: '', fields: { vaccine: 'Cat flu', given_on: '2025-10-03', next_due_on: '2026-10-03' } }],
      condition: [{ id: 4, kind: 'condition', status: 'PROPOSED', badge: { code: 'WAITING', text: 'Waiting to be checked' }, by: 'Sam', confirmed_by: null, supersedes_id: null, created_at: '', fields: { name: 'Itchy ears', condition_status: 'SUSPECTED', first_noted_on: null } }],
    },
  };
  const serve = (h: Health) => vi.stubGlobal('fetch', vi.fn((u: string) => json(200, u.endsWith('/health') ? h : [])));

  it('empty sections are hidden; a Viewer gets no add controls', async () => {
    serve(emptyHealth);
    render(<HealthTab a={viewer} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/nothing has been recorded/i)).toBeTruthy());
    expect(screen.queryByText('Vaccinations')).toBeNull();
    expect(screen.queryByText('Weight')).toBeNull();
    expect(screen.queryByLabelText('Add a record')).toBeNull();
  });
  it('records show their badges; an Owner can confirm a waiting one; a Family member is told it will wait', async () => {
    serve(withRecords);
    render(<HealthTab a={biscuit} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Cat flu')).toBeTruthy());
    expect(screen.getByText('Vet record')).toBeTruthy();
    expect(screen.getByText('Waiting to be checked')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1);
    expect(screen.queryByText('Allergies')).toBeNull();
    cleanup();
    serve(withRecords);
    render(<HealthTab a={family} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Cat flu')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByText(/waits for an owner or primary carer/i)).toBeTruthy();
  });
});

describe('TimelineTab (A19)', () => {
  it('year headers, newest first, each entry with its source badge', async () => {
    const entries: TimelineEntry[] = [
      { on: '2026-10-01', sort_on: '2026-10-01', year: '2026', category: 'WEIGHT', kind: 'MEASUREMENT_WEIGHT', label: 'Weight', title: '4.3 kg', detail: null, badge: { code: 'OUR_NOTE', text: 'Our note' }, ref: { table: 'measurement', id: 1 } },
      { on: '2025-10-03', sort_on: '2025-10-03', year: '2025', category: 'HEALTH', kind: 'VACCINATION', label: 'Vaccination', title: 'Cat flu', detail: 'next due 2026-10-03', badge: { code: 'VET_RECORD', text: 'Vet record' }, ref: { table: 'vaccination', id: 3 } },
    ];
    vi.stubGlobal('fetch', vi.fn(() => json(200, entries)));
    render(<TimelineTab a={viewer} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: '2026' })).toBeTruthy());
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['2026', '2025']);
    expect(screen.getByText('Our note')).toBeTruthy();
    expect(screen.getByText('Vet record')).toBeTruthy();
    expect(screen.getByText('next due 3 Oct 2026')).toBeTruthy();
  });
});

describe('todayIso is the date in Dublin (finding 7)', () => {
  it('turns over at midnight in Dublin, not at the phone\'s or UTC midnight', () => {
    expect(todayIso(new Date('2026-10-06T22:59:59Z'))).toBe('2026-10-06');
    expect(todayIso(new Date('2026-10-06T23:00:00Z'))).toBe('2026-10-07'); // 00:00 Irish Summer Time
    expect(todayIso(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31'); // GMT in winter
    expect(todayIso(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });
});

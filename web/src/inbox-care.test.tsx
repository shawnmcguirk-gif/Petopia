// S5-S7 web: Today / Coming Up hidden when empty and ticked with one tap; the inbox asks before reading and before AI;
// the two-step review; Household shows only the controls the engine allows. Fictional fixture: Biscuit, a cat.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgendaList } from './Agenda';
import type { AgendaItem, Animal, Household, InboxItem, MyInbox } from './api';
import { Home } from './Home';
import { HouseholdScreen } from './Household';
import { InboxScreen } from './Inbox';
import { InboxItemPage, Marked } from './InboxItem';
import { Nav } from './Nav';
import { parseRoute } from './route';
import { dueWords, scheduleWords } from './words';

const biscuit: Animal = {
  id: 7, species_id: 2, name: 'Biscuit', nickname: null, species: 'Cat', module: 'cat', breed: 'Domestic shorthair', sex: 'UNKNOWN', neuter_status: 'UNKNOWN',
  colour_markings: null, born: '2018', born_precision: 'YEAR', age: { years: 8, months: 0, text: 'about 8 years', approximate: true }, acquired: null,
  microchip: null, habitat: 'Home', kind: 'PET', status: 'ACTIVE', health_status: null, latest_weight: null, current_food: null, current_medication: [],
  vet: null, emergency_contact: null, photo: null, my_role: 'OWNER',
  can: ['VIEW', 'LOG_CARE', 'ADD_MEDIA', 'DROP_DOCUMENTS', 'PROPOSE_RECORDS', 'CONFIRM_RECORDS', 'MANAGE_CARE', 'EDIT_PROFILE', 'MANAGE_ROLES', 'SEE_DOCUMENTS'],
};
const viewer: Animal = { ...biscuit, my_role: 'VIEWER', can: ['VIEW'] };
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const feed: AgendaItem = { key: 'r-1-2026-10-07-08:00', animal_id: 7, animal: 'Biscuit', kind: 'FEED', title: 'Feed', due_on: '2026-10-07', time: '08:00', overdue: false, days: 0, detail: null, routine_id: 1, can_log: true };
const vac: AgendaItem = { key: 'vac', animal_id: 7, animal: 'Biscuit', kind: 'VACCINATION_DUE', title: 'Cat flu vaccination', due_on: '2026-10-25', time: null, overdue: false, days: 18, detail: null, routine_id: null, can_log: false };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('words', () => {
  it('schedules and due dates in plain words', () => {
    expect(scheduleWords('FREQ=DAILY', ['08:00', '18:00'])).toBe('Every day at 08:00, 18:00');
    expect(scheduleWords('FREQ=MONTHLY;INTERVAL=3', [])).toBe('Every 3 months');
    expect(scheduleWords('FREQ=WEEKLY;BYDAY=MO,TH', [])).toBe('Every week on Mon, Thu');
    expect(dueWords(18)).toBe('in 18 days');
    expect(dueWords(-1)).toBe('1 day overdue');
  });
  it('routes for the new screens', () => {
    expect(parseRoute('#/inbox')).toEqual({ name: 'inbox' });
    expect(parseRoute('#/inbox/4')).toEqual({ name: 'inbox-item', id: 4 });
    expect(parseRoute('#/household')).toEqual({ name: 'household' });
    expect(parseRoute('#/animals')).toEqual({ name: 'animals' });
  });
});

describe('Home: Today and Coming Up (A23)', () => {
  it('shows each section only when it has something; the inbox card only when something waits', () => {
    render(<Home animals={[biscuit]} agenda={{ today: [], coming_up: [], inbox_waiting: 0 }} />);
    expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Coming Up' })).toBeNull();
    expect(screen.queryByText(/to check/)).toBeNull();
    cleanup();
    render(<Home animals={[biscuit]} agenda={{ today: [feed], coming_up: [vac], inbox_waiting: 2 }} />);
    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(screen.getByText('Biscuit — Feed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Coming Up' })).toBeTruthy();
    expect(screen.getByText(/in 18 days/)).toBeTruthy();
    expect(screen.getByText('2 documents to check')).toBeTruthy();
  });
  it('one tap Done writes the care log for that occurrence; a second phone hears who did it', async () => {
    const f = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>(() => json(201, { logged: false, by: 'Sam', at: '2026-10-07T08:01:00Z' }));
    vi.stubGlobal('fetch', f);
    const done = vi.fn();
    render(<AgendaList items={[feed]} done onDone={done} />);
    fireEvent.click(screen.getByRole('button', { name: /done: biscuit feed 08:00/i }));
    await waitFor(() => expect(screen.getByText('Already done by Sam')).toBeTruthy());
    expect(f.mock.calls[0]![0]).toBe('api/animals/7/care-log');
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ routine_id: 1, due_on: '2026-10-07', due_slot: '08:00' });
    expect(done).toHaveBeenCalled();
  });
  it('a Viewer sees the list without Done', () => {
    render(<AgendaList items={[{ ...feed, can_log: false }]} done />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('navigation (sec 8.2)', () => {
  it('Home, Animals, Inbox -- no Wildlife tab yet, no Ask button', () => {
    render(<Nav route={{ name: 'home' }} waiting={3} />);
    expect(screen.getAllByRole('link').map((l) => l.textContent?.replace(/\d+$/, ''))).toEqual(['Home', 'Animals', 'Inbox']);
    expect(screen.queryByText(/wildlife|ask/i)).toBeNull();
    expect(screen.getByLabelText('3 to check')).toBeTruthy();
  });
});

const me = (over: Partial<MyInbox> = {}): MyInbox => ({ folder: 'Alex', suggested_folder: 'Alex', inbox_path: 'Alex/Pets/inbox', reading: false, ai_reading: false, folder_words: 'Petopia will read the files you put in "Alex/Pets/inbox"…', ai_words: 'Petopia will send the TEXT of each document … to Claude (Anthropic)…', local_reader: false, ...over });
const serveInbox = (m: MyInbox) => vi.stubGlobal('fetch', vi.fn((u: string) => json(200, u === 'api/inbox/me' ? m : { waiting: [], recent: [] })));

describe('Inbox: nothing read, nothing sent to Claude, until you say yes (A20)', () => {
  it('no folder yet -> set one up', async () => {
    serveInbox(me({ folder: null, inbox_path: null }));
    render(<InboxScreen animals={[biscuit]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /set up my folder/i })).toBeTruthy());
  });
  it('folder set, no go-ahead -> the words, and a yes button for each; AI waits for the folder', async () => {
    serveInbox(me());
    render(<InboxScreen animals={[biscuit]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /yes, read my pets folder/i })).toBeTruthy());
    expect(screen.getByText(/to Claude \(Anthropic\)/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /yes, let claude read/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/wait for you to enter the details by hand/)).toBeTruthy();
    expect(screen.getByText('Add document')).toBeTruthy();
  });
  it('both on -> each can be turned off', async () => {
    serveInbox(me({ reading: true, ai_reading: true }));
    render(<InboxScreen animals={[biscuit]} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Turn off' })).toHaveLength(2));
  });
  it('a Viewer gets no folder and no Add button', async () => {
    serveInbox(me());
    render(<InboxScreen animals={[viewer]} />);
    await waitFor(() => expect(screen.getByText('Nothing waiting to be checked.')).toBeTruthy());
    expect(screen.queryByText('Add document')).toBeNull();
  });
});

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 4, file_name: 'invoice.pdf', status: 'NEEDS_REVIEW', flags: ['VALUES_DROPPED'], member_name: 'Alex', animal_id: null, animal_proposed_id: 7, doc_kind: null, doc_kind_proposed: 'INVOICE',
  document_date: '2026-10-03', dropped_count: 1, discovered_at: '2026-10-07', filed_at: null, document_id: 9, document_date_assumed: false, decided_by: null, filed_path: null,
  found: { animal: { name: 'Biscuit', species: 'cat', microchip: null, page: 1, quote: 'Patient: Biscuit' } },
  pages: [{ page: 1, text: 'Patient: Biscuit\nWeight: 4.2 kg\nVaccination: Cat flu' }], read_by: 'TEXT_LAYER',
  proposals: [
    { id: 1, target: 'weight', payload: { value: '4.2', unit: 'kg' }, corrected: null, page: 1, quote: 'Weight: 4.2 kg', flags: [], status: 'PROPOSED', decided_by: null, created_table: null, created_row_id: null },
    { id: 2, target: 'vaccination', payload: { vaccine: 'Cat flu', given_on: '2026-10-03' }, corrected: null, page: 1, quote: 'Vaccination: Cat flu', flags: ['DATE_NOT_IN_QUOTE'], status: 'PROPOSED', decided_by: null, created_table: null, created_row_id: null },
  ],
  runs: [], my_role: 'OWNER', can_confirm: true, ...over,
});

describe('Checking a document: two steps (A21)', () => {
  it('step 1 first: what it is, for which animal, from when -- values are not offered yet', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(200, item())));
    render(<InboxItemPage id={4} animals={[biscuit]} />);
    await waitFor(() => expect(screen.getByText(/this looks like a vet invoice for/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /yes, check the values/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep document only/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /not a pet document/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^accept$/i })).toBeNull();
    expect(screen.getByText(/some values were not shown/i)).toBeTruthy();
  });
  it('step 2: each value with page and quote; accept-all only covers values without warnings; filing waits until all are judged', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(200, item({ decided_by: 'Alex', animal_id: 7, doc_kind: 'INVOICE' }))));
    render(<InboxItemPage id={4} animals={[biscuit]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept all 1 that passed checks' })).toBeTruthy());
    expect(screen.getByText('Page 1: “Weight: 4.2 kg”')).toBeTruthy();
    expect(screen.getByText(/date not in the quoted words/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: '2 still to look at' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/confirmed by you/)).toBeTruthy();
  });
  it('finding 4: a date that could be day/month or month/day is not pre-filled -- the person must set it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(200, item({ flags: ['DATE_ORDER_AMBIGUOUS'] }))));
    render(<InboxItemPage id={4} animals={[biscuit]} />);
    await waitFor(() => expect(screen.getByLabelText(/day\/month unclear/i)).toBeTruthy());
    expect((screen.getByLabelText(/day\/month unclear/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: /yes, check the values/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('finding 5: an unusual weight is asked about; only "Yes, that\'s right" sends confirm_unusual', async () => {
    const decided = item({ decided_by: 'Alex', animal_id: 7, doc_kind: 'INVOICE', proposals: [{ ...item().proposals[0]!, payload: { value: '42', unit: 'kg' }, quote: 'Weight: 42 kg', flags: ['UNUSUAL_WEIGHT'] }] });
    const f = vi.fn((u: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return json(200, decided);
      const b = JSON.parse(String(init.body)) as { confirm_unusual?: boolean };
      return b.confirm_unusual ? json(200, decided) : json(409, { error: '42 kg is outside the usual range for a cat. Did you mean 4.2 kg?', needs_confirmation: true, suggestion: { value: '4.2', unit: 'kg' } });
    });
    vi.stubGlobal('fetch', f);
    render(<InboxItemPage id={4} animals={[biscuit]} />);
    await waitFor(() => expect(screen.getByText(/very different from the last weight/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /accept all/i })).toBeNull(); // the flagged weight is not in "accept all"
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/did you mean 4.2 kg/i));
    expect(screen.getByRole('button', { name: 'Use 4.2 kg' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /yes, that.s right/i }));
    await waitFor(() => expect(f.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(2));
    const posts = f.mock.calls.filter((c) => c[1]?.method === 'POST').map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>);
    expect(posts[0]).toEqual({ action: 'accept' });
    expect(posts[1]).toEqual({ action: 'accept', confirm_unusual: true });
  });
  it('the page text marks the quoted words', () => {
    const { container } = render(<Marked text={'Patient: Biscuit\nWeight:   4.2 kg'} quotes={['Weight: 4.2 kg']} />);
    expect(container.querySelector('mark')?.textContent).toBe('Weight:   4.2 kg');
  });
});

describe('Household (A26)', () => {
  const h: Household = {
    me: { member: 'Alex', admin: true, manages: true },
    members: [{ member_name: 'Alex', display_name: null, is_child: false, granted_at: '', granted_by: '', admin: true }, { member_name: 'Sam', display_name: null, is_child: true, granted_at: '', granted_by: '', admin: false }],
    animals: [{ id: 7, name: 'Biscuit', status: 'ACTIVE', roles: [{ member_name: 'Alex', role: 'OWNER', explicit: true }, { member_name: 'Sam', role: 'FAMILY', explicit: false }] }],
    habitats: [{ id: 1, name: 'Home', kind: 'HOME', parent_id: null }], contacts: [],
  };
  it('an Owner changes roles; an admin gives access; others only see', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(200, h)));
    render(<HouseholdScreen animals={[biscuit]} />);
    await waitFor(() => expect(screen.getByLabelText("Sam's role for Biscuit")).toBeTruthy());
    expect(screen.getByRole('button', { name: /give access/i })).toBeTruthy();
    cleanup();
    vi.stubGlobal('fetch', vi.fn(() => json(200, { ...h, me: { member: 'Sam', admin: false, manages: false } })));
    render(<HouseholdScreen animals={[{ ...biscuit, my_role: 'FAMILY', can: ['VIEW'] }]} />);
    await waitFor(() => expect(screen.getByText('Family member (default)')).toBeTruthy());
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /give access|remove/i })).toBeNull();
  });
});

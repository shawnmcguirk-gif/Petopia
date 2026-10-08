// Any kind of animal (Ryan, 2026-10-08; migration 015). Runs only against petopia_test, like db.test.ts.
// Fixtures are fictional: a rabbit "Clover", a tarantula "Hairy", a goldfish "Bubbles".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { createAnimal, getAnimal, listSpecies, updateAnimal } = await import('../src/animals.js');
const { matchAnimal } = await import('../src/inbox.js');
const { closePool, withTxn } = await import('../src/db.js');

const run = `a${Date.now().toString(36)}`;
const me = `${run}-alex`;
const T = '2026-10-08';

async function newHousehold(member: string): Promise<number> {
  return withTxn(null, false, async (c) => {
    const id = Number((await c.query<{ id: string }>("SELECT nextval(pg_get_serial_sequence('core.workspace','workspace_id'))::text AS id")).rows[0]!.id);
    await c.query("SELECT set_config('app.current_workspace_id', $1, true)", [String(id)]);
    await c.query("INSERT INTO core.workspace (workspace_id, display_name, created_by) VALUES ($1, $2, 'test')", [id, `${run} household`]);
    await c.query("INSERT INTO core.habitat (workspace_id, name, kind, created_by) VALUES ($1, 'Home', 'HOME', 'test')", [id]);
    await c.query("INSERT INTO core.access_grant (workspace_id, member_name, granted_by) VALUES ($1, $2, 'test')", [id, member]);
    return id;
  });
}

describe.skipIf(!URL_)('any kind of animal (015)', () => {
  let W = 0;
  beforeAll(async () => { W = await newHousehold(me); });
  afterAll(async () => closePool());
  const add = (b: Record<string, unknown>) => withTxn(W, false, (c) => createAnimal(c, W, me, b, T));

  it('offers every pet species that has a module, dogs and cats first, "Other animal" last', async () => {
    const list = await withTxn(W, true, (c) => listSpecies(c));
    const names = list.map((s) => s.name);
    expect(names.slice(0, 2)).toEqual(['Dog', 'Cat']);
    expect(names[names.length - 1]).toBe('Other animal');
    for (const n of ['Rabbit', 'Guinea pig', 'Budgerigar', 'Chicken', 'Bearded dragon', 'Axolotl', 'Goldfish', 'Bala shark', 'Angelfish', 'Tiger barb', 'Torpedo barb', 'Horse', 'Goat']) expect(names, n).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    expect(list.every((s) => s.module.length > 0)).toBe(true);
  });

  it('knows the garden wildlife, but does not offer it as a pet to add', async () => {
    const wild = await withTxn(W, true, (c) => c.query<{ common_name: string; module_code: string | null }>("SELECT common_name, module_code FROM ref.species WHERE domain = 'WILD'"));
    const names = wild.rows.map((r) => r.common_name);
    for (const n of ['Robin', 'Collared dove', 'Blackbird', 'House sparrow', 'Starling', 'Wood pigeon', 'Blue tit', 'Great tit', 'Coal tit', 'Long-tailed tit', 'Bullfinch', 'Song thrush', 'Sparrowhawk', 'Red fox', 'Grey squirrel', 'Common frog']) expect(names, n).toContain(n);
    expect(wild.rows.every((r) => r.module_code === null)).toBe(true);
    const offered = (await withTxn(W, true, (c) => listSpecies(c))).map((s) => s.name);
    expect(offered).not.toContain('Robin');
    await expect(add({ name: 'Freddie', species: 'Red fox' })).rejects.toMatchObject({ status: 400 });
  });

  it('adds a rabbit by name (any case), by id, and keeps "dog" / "cat" working', async () => {
    const rabbit = await add({ name: 'Clover', species: 'rabbit', born: '2023', ext: { housing: 'BOTH' } });
    expect(rabbit).toMatchObject({ species: 'Rabbit', module: 'small_mammal', my_role: 'OWNER', ext: { housing: 'BOTH' } });
    const id = (await withTxn(W, true, (c) => listSpecies(c))).find((s) => s.name === 'Goldfish')!.id;
    expect(await add({ name: 'Bubbles', species: id, ext: { water_type: 'FRESH', group_size: 1 } })).toMatchObject({ species: 'Goldfish', module: 'aquarium_fish' });
    expect(await add({ name: 'Rex', species: 'dog' })).toMatchObject({ species: 'Dog', module: 'dog' });
    expect(await add({ name: 'Mog', species: 'Cat' })).toMatchObject({ species: 'Cat', module: 'cat' });
  });

  it('refuses a species it does not know, and a field that belongs to another module', async () => {
    await expect(add({ name: 'Sparkle', species: 'unicorn' })).rejects.toMatchObject({ status: 400 });
    await expect(add({ name: 'Sparkle', species: '' })).rejects.toMatchObject({ status: 400 });
    await expect(add({ name: 'Sparkle', species: 99999999 })).rejects.toMatchObject({ status: 400 });
    await expect(add({ name: 'Clover2', species: 'Rabbit', ext: { walk_minutes_target: 30 } })).rejects.toMatchObject({ status: 422 });
  });

  it('"Other animal" needs what the person calls it, shows that, and stores it on the animal only', async () => {
    await expect(add({ name: 'Hairy', species: 'Other animal' })).rejects.toMatchObject({ status: 400 });
    await expect(add({ name: 'Hairy', species: 'Other animal', ext: { species_name: '   ' } })).rejects.toMatchObject({ status: 400 });
    const t = await add({ name: 'Hairy', species: 'Other animal', ext: { species_name: '  Tarantula ' } });
    expect(t).toMatchObject({ species: 'Tarantula', module: 'other', ext: { species_name: 'Tarantula' } });
    const shared = await withTxn(W, true, (c) => c.query("SELECT count(*)::int AS n FROM ref.species WHERE lower(common_name) = 'tarantula'"));
    expect((shared.rows[0] as { n: number }).n).toBe(0); // nothing a household types reaches the shared species table
    const g = await add({ name: 'Heidi', species: 'Goat' }); // a species with its own row on the same module needs no typing
    expect(g).toMatchObject({ species: 'Goat', module: 'other' });
  });

  it('edits an animal\'s ext against its own module, not the species\' old one-species-per-module link', async () => {
    const r = await add({ name: 'Thumper', species: 'Rabbit' });
    const u = await withTxn(W, false, (c) => updateAnimal(c, r.id, me, { ext: { housing: 'INDOOR' } }, T));
    expect(u.ext).toEqual({ housing: 'INDOOR' });
    await expect(withTxn(W, false, (c) => updateAnimal(c, r.id, me, { ext: { housing: 'CASTLE' } }, T))).rejects.toMatchObject({ status: 422 });
    expect((await withTxn(W, true, (c) => getAnimal(c, r.id, me, T))).ext).toEqual({ housing: 'INDOOR' });
  });

  it('"Other animal" cannot lose its name later: an edit that blanks or removes it is refused, a rename is trimmed', async () => {
    const t = await add({ name: 'Webster', species: 'Other animal', ext: { species_name: 'Tarantula' } });
    await expect(withTxn(W, false, (c) => updateAnimal(c, t.id, me, { ext: {} }, T))).rejects.toMatchObject({ status: 400 });
    await expect(withTxn(W, false, (c) => updateAnimal(c, t.id, me, { ext: { species_name: '  ' } }, T))).rejects.toMatchObject({ status: 400 });
    const u = await withTxn(W, false, (c) => updateAnimal(c, t.id, me, { ext: { species_name: ' Huntsman spider ' } }, T));
    expect(u).toMatchObject({ species: 'Huntsman spider', ext: { species_name: 'Huntsman spider' } });
    const g = await add({ name: 'Heidi2', species: 'Goat' }); // a species with its own row may have an empty ext
    expect((await withTxn(W, false, (c) => updateAnimal(c, g.id, me, { ext: {} }, T))).species).toBe('Goat');
  });

  it('a printed document finds the right animal by name + the species it names, even for "Other animal"', async () => {
    const m = (name: string, species: string | null) => withTxn(W, true, (c) => matchAnimal(c, { name, species, microchip: null }));
    const bun = await add({ name: 'Biscuit', species: 'Rabbit' });
    const cat = await add({ name: 'Biscuit', species: 'Cat' });
    const spider = await add({ name: 'Biscuit', species: 'Other animal', ext: { species_name: 'Tarantula' } });
    expect(await m('Biscuit', 'Domestic rabbit')).toBe(bun.id);
    expect(await m('Biscuit', 'cats')).toBe(cat.id);
    expect(await m('Biscuit', 'Tarantula (Chilean rose)')).toBe(spider.id);
    expect(await m('Biscuit', null)).toBeNull(); // three of that name and no species: it asks, never guesses
    expect(await m('Biscuit', 'hamster')).toBeNull();
  });
});

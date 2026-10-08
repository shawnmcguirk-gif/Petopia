// D2 slice A1 against the real test database (petopia_test): name normalisation, aliases, the write guards, the content loader,
// the researched page, "Budgie" -> Budgerigar, and adoption of "Other animal" animals. Fixtures are fictional.
// The loader tests spawn the real scripts/load-about.mjs, which imports the BUILT validation code: run `npm run build` first.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '../src/db.js';

const URL_ = process.env.PETOPIA_TEST_DATABASE_URL;
if (URL_) process.env.PETOPIA_DATABASE_URL = URL_;

const { createAnimal, getAnimal, listSpecies, switchSpecies, updateAnimal } = await import('../src/animals.js');
const { aboutKind, getSpeciesPage, normaliseKind, resolveKind } = await import('../src/about.js');
const { WITHHELD_TEXT } = await import('../src/aboutguard.js');
const { closePool, withTxn } = await import('../src/db.js');

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const REAL_ALIASES = JSON.parse(readFileSync(new URL('../../content/aliases.json', import.meta.url), 'utf8')) as Record<string, string[]>;
const run = `a${Date.now().toString(36)}`;
const me = `${run}-alex`;
const T = '2026-10-08';
const TODAY = new Date().toISOString().slice(0, 10);
const BIRD = `Testbird ${run}`; // a throwaway WILD species, removed in afterAll
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

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

/** Run SQL as the content loader would (the write-guard flag on, inside one transaction). */
const asLoader = <R>(fn: (c: Client) => Promise<R>): Promise<R> =>
  withTxn(null, false, async (c) => {
    await c.query("SELECT set_config('petopia.loader', 'on', true)");
    return fn(c);
  });

function loader(args: string[]): { code: number | null; out: string } {
  if (!existsSync(join(ENGINE, 'dist/src/aboutpage.js'))) throw new Error('dist/ is missing: run `npm run build` in engine/ first (the loader imports the built validation code)');
  const env: NodeJS.ProcessEnv = { ...process.env, PETOPIA_DATABASE_URL: URL_ };
  delete env.PETOPIA_LOADER_DATABASE_URL;
  const r = spawnSync(process.execPath, [join(ENGINE, 'scripts/load-about.mjs'), ...args], { cwd: ENGINE, env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const src = (n: number, publisher: string) => ({ title: `Source ${n}`, publisher, url: `https://example.org/${run}/${n}`, checked_on: TODAY });
const one = (text: string) => ({ statements: [text], sources: [src(1, 'Publisher A')] });
function birdPage(diet = 'Eats insects, worms, seeds and berries.') {
  return {
    species: BIRD, checked_on: TODAY, written_by: 'a test fixture', reviewed_by: 'ryan',
    sections: {
      summary: one('A fictional small bird used only by the tests.'),
      characteristics: one('Round body, thin legs, dark eyes and a short bill.'),
      habits: one('Defends a territory all year, even through the winter.'),
      diet: one(diet),
      housing: one('Lives in woods, hedges and gardens with some cover.'),
      lifespan: one('Most live about two years in the wild.'),
      breeding: { statements: ['Nests low in a hollow or a bank.'], sources: [src(1, 'Publisher A'), src(2, 'Publisher B')] },
    },
  };
}

describe.skipIf(!URL_)('About pages, slice A1 (migration 017)', () => {
  let W = 0;
  let birdId = 0;
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'about-')); dirs.push(d); return d; };
  const add = (b: Record<string, unknown>) => withTxn(W, false, (c) => createAnimal(c, W, me, b, T));

  beforeAll(async () => {
    W = await newHousehold(me);
    birdId = await asLoader(async (c) => Number((await c.query<{ id: string }>(`INSERT INTO ref.species (common_name, "group", domain) VALUES ($1, 'BIRD', 'WILD') RETURNING species_id::text AS id`, [BIRD])).rows[0]!.id));
    const r = loader(['aliases']); // the real aliases file, so every test below sees the shipped aliases
    expect(r.code, r.out).toBe(0);
  });
  afterAll(async () => {
    await asLoader(async (c) => {
      await c.query('DELETE FROM ref.species_about WHERE species_id = $1', [birdId]);
      await c.query('DELETE FROM ref.species_alias WHERE species_id = $1', [birdId]);
      await c.query('DELETE FROM ref.species WHERE species_id = $1', [birdId]);
    }).catch(() => undefined);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await closePool();
  });

  describe('name normalisation (one definition, in SQL)', () => {
    it('lower-cases, folds width and accent form, turns - _ / and whitespace into one space, drops other punctuation', async () => {
      const n = (s: string) => withTxn(W, true, (c) => normaliseKind(c, s));
      expect(await n(' Guinea-pig ')).toBe('guinea pig');
      expect(await n('WOOD   pigeon!')).toBe('wood pigeon');
      expect(await n("Budgie's")).toBe('budgies');
      expect(await n('Écureuil')).toBe('écureuil');
      expect(await n('écureuil')).toBe('écureuil'); // decomposed accent == precomposed
      expect(await n('Ｒabbit')).toBe('rabbit'); // full-width letter
      expect(await n('a\tb\nc')).toBe('a b c');
      expect(await n('a_b/c')).toBe('a b c');
      expect(await n('---')).toBe('');
      expect(await n('')).toBe('');
      expect(await n('a\u00a0b')).toBe('a b'); // a no-break space is a space
      expect(await n('a\u200bb')).toBe('ab'); // a zero-width space is dropped
      expect(await n('\u0301')).toBe(''); // a combining mark on its own is nothing
      expect(await n('🐍')).toBe(''); // an emoji is nothing
    });

    it('two species cannot share a normalised name', async () => {
      await expect(asLoader((c) => c.query(`INSERT INTO ref.species (common_name, "group", domain) VALUES ('GUINEA-PIG', 'MAMMAL', 'PET')`))).rejects.toThrow(/uq_species_normalised|duplicate key/);
    });
  });

  describe('write guards and clash triggers', () => {
    it('refuses a write to either researched table unless the loader flag is on', async () => {
      await expect(withTxn(W, false, (c) => c.query(`INSERT INTO ref.species_alias (alias, species_id) VALUES ('zz guard test', $1)`, [birdId]))).rejects.toThrow(/content loader/);
      await expect(withTxn(W, false, (c) => c.query(`DELETE FROM ref.species_alias WHERE alias = 'budgie'`))).rejects.toThrow(/content loader/);
      await expect(withTxn(W, false, (c) => c.query(`INSERT INTO ref.species_about (species_id, version, sections, checked_on, written_by, content_hash) VALUES ($1, 1, '{}', '2026-10-08', 'x', 'h')`, [birdId]))).rejects.toThrow(/content loader/);
    });

    it('the flag is only ever set by the loader script, never by engine code', () => {
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      const hits = walk(join(ENGINE, 'src')).filter((f) => readFileSync(f, 'utf8').includes('petopia.loader'));
      expect(hits).toEqual([]);
    });

    it('an alias must already be normalised', async () => {
      await expect(asLoader((c) => c.query(`INSERT INTO ref.species_alias (alias, species_id) VALUES ('Budgie', $1)`, [birdId]))).rejects.toThrow(/check|normal/i);
    });

    it('an alias cannot be the name of another species, nor belong to the Other animal placeholder', async () => {
      await expect(asLoader((c) => c.query(`INSERT INTO ref.species_alias (alias, species_id) VALUES ('rabbit', $1)`, [birdId]))).rejects.toThrow(/name of another species/);
      await expect(asLoader((c) => c.query(`INSERT INTO ref.species_alias (alias, species_id) SELECT 'zz placeholder', species_id FROM ref.species WHERE common_name = 'Other animal'`))).rejects.toThrow(/placeholder/);
    });

    it('a new species cannot take a name that is already someone else\'s alias', async () => {
      await expect(asLoader((c) => c.query(`INSERT INTO ref.species (common_name, "group", domain) VALUES ('Budgie', 'BIRD', 'PET')`))).rejects.toThrow(/already an alias/);
    });

    it('Goat, Sheep and Pig (module "other") may have aliases: only the placeholder is excluded', async () => {
      const r = await withTxn(W, true, (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ref.species_alias a JOIN ref.species s USING (species_id) WHERE s.common_name IN ('Goat', 'Sheep', 'Pig')`));
      expect(r.rows[0]!.n).toBeGreaterThanOrEqual(3);
    });
  });

  describe('resolving a typed kind', () => {
    const rk = (s: string) => withTxn(W, true, async (c) => (await resolveKind(c, s))?.common_name ?? null);
    it('finds a species by name, by alias, and by the same minus one trailing "s"', async () => {
      expect(await rk('rabbit')).toBe('Rabbit');
      expect(await rk('RABBITS')).toBe('Rabbit');
      expect(await rk('Budgie')).toBe('Budgerigar');
      expect(await rk('budgies')).toBe('Budgerigar');
      expect(await rk('guinea-pig')).toBe('Guinea pig');
      expect(await rk('Guinea pigs')).toBe('Guinea pig');
      expect(await rk('Denison barb')).toBe('Torpedo barb');
      expect(await rk('goats')).toBe('Goat');
      expect(await rk('Puppies')).toBe('Dog');
      expect(await rk('Wood-Pigeons')).toBe('Wood pigeon');
      expect(await rk('thrushes')).toBe('Song thrush');
    });
    it('finds nothing for an unknown kind, a short word, "…ss", or the placeholder itself', async () => {
      expect(await rk('Tarantula')).toBeNull();
      expect(await rk('bass')).toBeNull();
      expect(await rk('Other animal')).toBeNull();
      expect(await rk('other animals')).toBeNull();
      expect(await rk('')).toBeNull();
    });
    it('"squirrel" is deliberately not an alias: grey and red are different animals', async () => {
      expect(await rk('squirrel')).toBeNull();
      expect(await rk('Grey squirrel')).toBe('Grey squirrel');
    });
  });

  describe('the real aliases file', () => {
    it('every alias in the file resolves to its own species, and every species name to itself (no shadowing)', async () => {
      const rk = (s: string) => withTxn(W, true, async (c) => (await resolveKind(c, s))?.common_name ?? null);
      for (const [species, list] of Object.entries(REAL_ALIASES)) {
        expect(await rk(species), species).toBe(species);
        for (const a of list) expect(await rk(a), `${a} -> ${species}`).toBe(species);
      }
    });

    it('words that are too general to guess from are not aliases: "parakeet", "fish", "hog", "ass"', async () => {
      const rk = (s: string) => withTxn(W, true, async (c) => (await resolveKind(c, s))?.common_name ?? null);
      for (const w of ['parakeet', 'fish', 'hog', 'ass']) expect(await rk(w), w).toBeNull();
    });

    it('loads with no clash, makes the table equal the file, and a second run changes nothing', async () => {
      const r = loader(['aliases']);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/0 added, 0 removed/);
      const all = Object.values(REAL_ALIASES).flat();
      const n = await withTxn(W, true, (c) => c.query<{ have: number; want: number }>(
        `SELECT (SELECT count(*)::int FROM ref.species_alias WHERE species_id <> $2) AS have,
                (SELECT count(DISTINCT ref.normalise_kind(x))::int FROM jsonb_array_elements_text($1::jsonb) x) AS want`, [JSON.stringify(all), birdId]));
      expect(n.rows[0]!.have).toBe(n.rows[0]!.want);
    });

    it('--dry-run writes nothing; an extra alias is added, adopted by waiting animals, and removed again when the file drops it', async () => {
      const kind = `Zz Kookaburra ${run}`;
      const waiting = await add({ name: 'Wait', species: 'Other animal', ext: { species_name: kind } });
      expect(waiting).toMatchObject({ module: 'other', ext: { species_name: kind } });
      const withExtra = { ...REAL_ALIASES, Rabbit: [...REAL_ALIASES.Rabbit!, kind] };
      const dir = tmp();
      const file = join(dir, 'aliases.json');
      writeFileSync(file, JSON.stringify(withExtra));
      const aliasCount = () => withTxn(W, true, (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ref.species_alias WHERE alias = ref.normalise_kind($1)`, [kind])).then((r) => r.rows[0]!.n);

      let r = loader(['aliases', '--dry-run', '--file', file]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/DRY RUN/);
      expect(await aliasCount()).toBe(0);
      expect((await withTxn(W, true, (c) => getAnimal(c, waiting.id, me, T))).module).toBe('other'); // a dry run adopts nothing either

      r = loader(['aliases', '--file', file]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/1 added, 0 removed/);
      expect(r.out).toMatch(/1 animal\(s\) switched/);
      expect(await aliasCount()).toBe(1);
      expect(await withTxn(W, true, (c) => getAnimal(c, waiting.id, me, T))).toMatchObject({ species: 'Rabbit', module: 'rabbit', ext: {} });

      r = loader(['aliases']); // back to the real file: the extra alias goes
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/0 added, 1 removed/);
      expect(await aliasCount()).toBe(0);
    });

    it('refuses a file where an alias is claimed by two species, or names an unknown species or the placeholder, and writes nothing', async () => {
      const dir = tmp();
      const file = join(dir, 'bad.json');
      writeFileSync(file, JSON.stringify({ ...REAL_ALIASES, Dog: [...REAL_ALIASES.Dog!, 'Bunny'] })); // 'bunny' belongs to Rabbit
      let r = loader(['aliases', '--file', file]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/claimed by two species/);
      writeFileSync(file, JSON.stringify({ ...REAL_ALIASES, Unicorn: ['horned horse'] }));
      r = loader(['aliases', '--file', file]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/unknown species "Unicorn"/);
      writeFileSync(file, JSON.stringify({ ...REAL_ALIASES, 'Other animal': ['thing'] }));
      r = loader(['aliases', '--file', file]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/placeholder/);
      expect((await withTxn(W, true, (c) => resolveKind(c, 'bunny')))?.common_name).toBe('Rabbit'); // the real table is untouched
    });
  });

  describe('the page loader', () => {
    it('validates everything first: a bad file anywhere writes nothing, and says which rule', async () => {
      const dir = tmp();
      writeFileSync(join(dir, `${slug(BIRD)}.json`), JSON.stringify(birdPage()));
      writeFileSync(join(dir, 'robin.json'), JSON.stringify({ ...birdPage('See https://www.rspb.org.uk for the foods.'), species: 'Robin' }));
      const r = loader(['pages', '--dir', dir]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/robin\.json: diet statement 1 is refused by guard rule LINK/);
      expect(r.out).toMatch(/REFUSED/);
      expect((await withTxn(W, true, (c) => getSpeciesPage(c, birdId))).state).toBe('NONE'); // the good file was not loaded either
    });

    it('refuses a file named wrongly, an unknown species, and invalid JSON', () => {
      const dir = tmp();
      writeFileSync(join(dir, 'wrong-name.json'), JSON.stringify(birdPage()));
      writeFileSync(join(dir, 'unicorn.json'), JSON.stringify({ ...birdPage(), species: 'Unicorn' }));
      writeFileSync(join(dir, 'broken.json'), '{ nope');
      const r = loader(['pages', '--dir', dir]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/file name must be testbird/);
      expect(r.out).toMatch(/no species called "Unicorn"/);
      expect(r.out).toMatch(/broken\.json: not valid JSON/);
    });

    it('loads NEW, then UNCHANGED, then UPDATED as version 2 (version 1 retired), then retires only once the file is gone', async () => {
      const dir = tmp();
      const file = join(dir, `${slug(BIRD)}.json`);
      writeFileSync(file, JSON.stringify(birdPage()));
      const state = () => withTxn(W, true, (c) => getSpeciesPage(c, birdId));

      let r = loader(['pages', '--dir', dir, '--dry-run']);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/NEW Testbird/);
      expect((await state()).state).toBe('NONE'); // a dry run writes nothing

      r = loader(['pages', '--dir', dir]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/NEW Testbird .*\(version 1\)/);
      const p1 = await state();
      expect(p1.state).toBe('PAGE');
      if (p1.state !== 'PAGE') return;
      expect(p1).toMatchObject({ version: 1, written_by: 'a test fixture', reviewed_by: 'ryan', checked_on: TODAY, source_count: 2 });
      expect(p1.species).toMatchObject({ id: birdId, common_name: BIRD, domain: 'WILD' });
      expect(p1.headings.housing).toBe('Habitat'); // a wild animal has a habitat, not housing
      expect(p1.headings.diet).toBe('What it eats');
      expect(Object.keys(p1.sections)).toEqual(['summary', 'characteristics', 'habits', 'diet', 'housing', 'lifespan', 'breeding']);
      expect(p1.sections.diet!.statements).toEqual([{ text: 'Eats insects, worms, seeds and berries.', withheld: false }]);

      r = loader(['pages', '--dir', dir]);
      expect(r.out).toMatch(/UNCHANGED Testbird/);

      writeFileSync(file, JSON.stringify(birdPage('Eats mostly insects and a few berries.')));
      r = loader(['pages', '--dir', dir]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/UPDATED Testbird .*\(version 2\)/);
      const rows = await withTxn(W, true, (c) => c.query<{ version: number; live: boolean }>('SELECT version, retired_at IS NULL AS live FROM ref.species_about WHERE species_id = $1 ORDER BY version', [birdId]));
      expect(rows.rows).toEqual([{ version: 1, live: false }, { version: 2, live: true }]);
      const p2 = await state();
      expect(p2.state === 'PAGE' && p2.sections.diet!.statements[0]!.text).toBe('Eats mostly insects and a few berries.');

      r = loader(['retire', BIRD, '--dir', dir]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/still exists/);
      expect((await state()).state).toBe('PAGE');
      rmSync(file);
      r = loader(['retire', BIRD, '--dir', dir]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/retired 1 live page/);
      expect((await state()).state).toBe('NONE');
    });

    it('a stored statement that breaks a guard rule is withheld when shown (the display-time guard)', async () => {
      const page = birdPage('See https://www.rspb.org.uk for the foods.');
      await asLoader((c) => c.query(
        `INSERT INTO ref.species_about (species_id, version, sections, checked_on, written_by, content_hash) VALUES ($1, 90, $2, $3, 'a test fixture', $4)`,
        [birdId, JSON.stringify(page.sections), TODAY, `hash-${run}`]));
      const p = await withTxn(W, true, (c) => getSpeciesPage(c, birdId));
      expect(p.state).toBe('PAGE');
      if (p.state !== 'PAGE') return;
      expect(p.sections.diet!.statements).toEqual([{ text: WITHHELD_TEXT, withheld: true }]);
      expect(p.sections.summary!.statements[0]!.withheld).toBe(false);
      await asLoader((c) => c.query('UPDATE ref.species_about SET retired_at = now() WHERE species_id = $1 AND retired_at IS NULL', [birdId]));
    });

    it('retire refuses a species that does not exist, and one with no live page', () => {
      let r = loader(['retire', 'Zz Not A Species', '--dir', tmp()]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/there is no species called/);
      r = loader(['retire', BIRD, '--dir', tmp()]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/no live page to retire/);
    });

    it('an empty aliases file is refused (it would delete every alias)', () => {
      const f = join(tmp(), 'empty.json');
      writeFileSync(f, '{}');
      const r = loader(['aliases', '--file', f]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/no species in it/);
    });

    it('a damaged stored row is shown as far as it can be, not as an error', async () => {
      await asLoader((c) => c.query(
        `INSERT INTO ref.species_about (species_id, version, sections, checked_on, written_by, content_hash) VALUES ($1, 93, $2, $3, 'a test fixture', $4)`,
        [birdId, JSON.stringify({ summary: 5, diet: { statements: ['Eats insects, worms and seeds.'] }, habits: 'no' }), TODAY, `hash-${run}-93`]));
      const p = await withTxn(W, true, (c) => getSpeciesPage(c, birdId));
      expect(p.state).toBe('PAGE');
      if (p.state === 'PAGE') { expect(p.source_count).toBe(0); expect(Object.keys(p.sections)).toEqual(['diet']); }
      await asLoader((c) => c.query('UPDATE ref.species_about SET retired_at = now() WHERE species_id = $1 AND retired_at IS NULL', [birdId]));
    });

    it('TRUNCATE is guarded too', async () => {
      await expect(withTxn(W, false, (c) => c.query('TRUNCATE ref.species_about'))).rejects.toThrow(/content loader/);
    });

    it('a reviewed_by that looks like a link is not shown as "Read by"', async () => {
      await asLoader((c) => c.query(
        `INSERT INTO ref.species_about (species_id, version, sections, checked_on, written_by, reviewed_by, content_hash) VALUES ($1, 94, $2, $3, 'a test fixture', 'see https://example.org', $4)`,
        [birdId, JSON.stringify(birdPage().sections), TODAY, `hash-${run}-94`]));
      const p = await withTxn(W, true, (c) => getSpeciesPage(c, birdId));
      expect(p.state === 'PAGE' && p.reviewed_by).toBeNull();
      await asLoader((c) => c.query('UPDATE ref.species_about SET retired_at = now() WHERE species_id = $1 AND retired_at IS NULL', [birdId]));
    });

    it('only one live page per species: a second live row is refused by the database', async () => {
      const page = birdPage();
      const ins = (v: number) => asLoader((c) => c.query(
        `INSERT INTO ref.species_about (species_id, version, sections, checked_on, written_by, content_hash) VALUES ($1, $2, $3, $4, 'a test fixture', $5)`,
        [birdId, v, JSON.stringify(page.sections), TODAY, `hash-${run}-${v}`]));
      await ins(91);
      await expect(ins(92)).rejects.toThrow(/uq_species_about_live|duplicate key/);
      await asLoader((c) => c.query('UPDATE ref.species_about SET retired_at = now() WHERE species_id = $1 AND retired_at IS NULL', [birdId]));
    });
  });

  describe('adding an animal by a typed kind', () => {
    const otherId = async () => (await withTxn(W, true, (c) => listSpecies(c))).find((s) => s.name === 'Other animal')!.id;

    it('"Budgie", "guinea-pig", "Denison barb", "rabbits", "goats" and "Puppies" each save the real species', async () => {
      const t = (species_name: string) => add({ name: `T-${species_name}`, species: 'Other animal', ext: { species_name } });
      expect(await t('Budgie')).toMatchObject({ species: 'Budgerigar', ext: {} });
      expect(await t('guinea-pig')).toMatchObject({ species: 'Guinea pig', ext: {} });
      expect(await t('Denison barb')).toMatchObject({ species: 'Torpedo barb', ext: {} });
      expect(await t('rabbits')).toMatchObject({ species: 'Rabbit', module: 'rabbit', ext: {} });
      expect(await t('goats')).toMatchObject({ species: 'Goat', module: 'other', ext: {} });
      expect(await t('Puppies')).toMatchObject({ species: 'Dog', module: 'dog' });
    });

    it('a wild kind or an unknown kind stays "Other animal" with the typed name; nothing reaches the shared tables', async () => {
      const ph = await otherId();
      for (const kind of ['Robin', 'Wood pigeons', 'Tarantula', 'other animal']) {
        const a = await add({ name: `K-${kind}`, species: 'Other animal', ext: { species_name: kind } });
        expect(a, kind).toMatchObject({ species_id: ph, module: 'other', ext: { species_name: kind } });
      }
      const n = await withTxn(W, true, (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ref.species WHERE common_name ILIKE 'tarantula'`));
      expect(n.rows[0]!.n).toBe(0);
    });

    it('refuses a typed kind that is empty once normalised, or longer than 80 characters once normalised', async () => {
      await expect(add({ name: 'Q', species: 'Other animal', ext: { species_name: '!!!' } })).rejects.toMatchObject({ status: 400 });
      await expect(add({ name: 'Q', species: 'Other animal', ext: { species_name: '🐍' } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/letters or numbers/) as unknown });
      await expect(add({ name: 'Q', species: 'Other animal', ext: { species_name: 'ﷺﷺﷺﷺﷺ' } })).rejects.toMatchObject({ status: 400 }); // 5 characters that expand to 90 when normalised
      await expect(add({ name: 'Q', species: 'Other animal', ext: { species_name: 'x'.repeat(81) } })).rejects.toMatchObject({ status: 400 });
    });

    it('retyping an "Other animal" switches it when the new kind is a pet, and leaves it when it is wild or unknown', async () => {
      const a = await add({ name: 'Retype', species: 'Other animal', ext: { species_name: 'Tarantula' } });
      const stay = await withTxn(W, false, (c) => updateAnimal(c, a.id, me, { ext: { species_name: 'Robin' } }, T));
      expect(stay).toMatchObject({ module: 'other', ext: { species_name: 'Robin' } });
      const go = await withTxn(W, false, (c) => updateAnimal(c, a.id, me, { ext: { species_name: 'Guinea-pigs' } }, T));
      expect(go).toMatchObject({ species: 'Guinea pig', ext: {} });
    });

    it('the picker says which species have a page', async () => {
      const list = await withTxn(W, true, (c) => listSpecies(c));
      expect(list.every((s) => typeof s.has_about === 'boolean')).toBe(true);
      const axo = list.find((s) => s.name === 'Axolotl')!;
      await asLoader((c) => c.query(
        `INSERT INTO ref.species_about (species_id, version, sections, checked_on, written_by, content_hash) VALUES ($1, 9000, '{}', $2, 'a test fixture', $3)`, [axo.id, TODAY, `hash-axo-${run}`]));
      try {
        const after = await withTxn(W, true, (c) => listSpecies(c));
        expect(after.find((s) => s.name === 'Axolotl')!.has_about).toBe(true);
        expect(after.find((s) => s.name === 'Dog')!.has_about).toBe(false);
      } finally {
        await asLoader((c) => c.query('DELETE FROM ref.species_about WHERE species_id = $1 AND version = 9000', [axo.id]));
      }
    });
  });

  describe('GET about/kind', () => {
    const ak = (name: unknown) => withTxn(W, true, (c) => aboutKind(c, me, name));
    it('a wild species resolves to its species (read-only), a pet alias to the pet species, an unknown kind to NONE', async () => {
      expect(await ak('Robin')).toMatchObject({ tier: 'SPECIES', wild: true, species: { common_name: 'Robin', domain: 'WILD' } });
      expect(await ak('budgie')).toMatchObject({ tier: 'SPECIES', wild: false, species: { common_name: 'Budgerigar' } });
      const none = await ak('Tarantula');
      expect(none).toMatchObject({ tier: 'NONE' });
      expect(none.species).toBeUndefined();
      expect(typeof none.can_write).toBe('boolean');
    });
    it('refuses nothing-to-look-up input', async () => {
      await expect(ak('')).rejects.toMatchObject({ status: 400 });
      await expect(ak('   ')).rejects.toMatchObject({ status: 400 });
      await expect(ak('---')).rejects.toMatchObject({ status: 400 });
      await expect(ak('x'.repeat(81))).rejects.toMatchObject({ status: 400 });
      await expect(ak(42)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('POST animals/:id/species (switchSpecies)', () => {
    const sw = (id: number, species: unknown) => withTxn(W, false, (c) => switchSpecies(c, id, me, species, T));
    it('turns an "Other animal" into a pet species, by name or by id', async () => {
      const a = await add({ name: 'Sw1', species: 'Other animal', ext: { species_name: 'Zz mystery' } });
      expect(await sw(a.id, 'Rabbit')).toMatchObject({ species: 'Rabbit', module: 'rabbit', ext: {} });
      const b = await add({ name: 'Sw2', species: 'Other animal', ext: { species_name: 'Zz mystery' } });
      const hamster = (await withTxn(W, true, (c) => listSpecies(c))).find((s) => s.name === 'Hamster')!.id;
      expect(await sw(b.id, hamster)).toMatchObject({ species: 'Hamster' });
    });
    it('409 if the animal already has a kind, 404 for an unknown kind, 422 for a wild or placeholder species, 400 for no species', async () => {
      const done = await add({ name: 'Sw3', species: 'Rabbit' });
      await expect(sw(done.id, 'Dog')).rejects.toMatchObject({ status: 409 });
      const o = await add({ name: 'Sw4', species: 'Other animal', ext: { species_name: 'Zz mystery' } });
      await expect(sw(o.id, 'Unicorn')).rejects.toMatchObject({ status: 404 });
      await expect(sw(o.id, 'Robin')).rejects.toMatchObject({ status: 422 });
      const ph = (await withTxn(W, true, (c) => listSpecies(c))).find((s) => s.name === 'Other animal')!.id;
      await expect(sw(o.id, ph)).rejects.toMatchObject({ status: 422 });
      await expect(sw(o.id, '')).rejects.toMatchObject({ status: 400 });
      await expect(sw(o.id, null)).rejects.toMatchObject({ status: 400 });
      expect((await withTxn(W, true, (c) => getAnimal(c, o.id, me, T))).module).toBe('other'); // every refusal left it alone
    });
    it('is for members who can edit the profile only', async () => {
      const o = await add({ name: 'Sw5', species: 'Other animal', ext: { species_name: 'Zz mystery' } });
      await expect(withTxn(W, false, (c) => switchSpecies(c, o.id, `${run}-stranger`, 'Rabbit', T))).rejects.toThrow();
      expect((await withTxn(W, true, (c) => getAnimal(c, o.id, me, T))).module).toBe('other');
    });
  });

  describe('adopt_typed_kinds()', () => {
    it('is safe to run any time: it never throws, and a second run finds nothing', async () => {
      const first = await withTxn(null, false, (c) => c.query<{ n: number }>('SELECT animal.adopt_typed_kinds() AS n'));
      expect(first.rows[0]!.n).toBeGreaterThanOrEqual(0);
      const second = await withTxn(null, false, (c) => c.query<{ n: number }>('SELECT animal.adopt_typed_kinds() AS n'));
      expect(second.rows[0]!.n).toBe(0);
    });
    it('switches the right animals in every household, and leaves the others alone', async () => {
      const bea = `${run}-bea`;
      const W2 = await newHousehold(bea);
      const mk = async (w: number, member: string, species: string, typed: string, extra?: (id: number) => Promise<unknown>) => {
        const a = await withTxn(w, false, (c) => createAnimal(c, w, member, species === 'Other animal' ? { name: 'Adopt', species, ext: { species_name: `Zz ${run}` } } : { name: 'Adopt', species }, T));
        if (extra) await extra(a.id);
        await withTxn(w, false, (c) => c.query('UPDATE animal.animal SET ext = $1::jsonb WHERE animal_id = $2', [JSON.stringify({ species_name: typed }), a.id])); // typed behind the engine's back, as if the alias were new
        return a.id;
      };
      const budgie = await mk(W, me, 'Other animal', 'Budgie');
      const gone = await mk(W, me, 'Other animal', 'Budgie', (id) => withTxn(W, false, (c) => updateAnimal(c, id, me, { status: 'DECEASED', status_on: '2026-10-01' }, T)));
      const bunny = await mk(W2, bea, 'Other animal', 'rabbits');
      const wild = await mk(W, me, 'Other animal', 'Robin');
      const blank = await mk(W, me, 'Other animal', '!!!');
      const goat = await mk(W, me, 'Goat', 'Budgie'); // not an "Other animal": a stray typed name on it is none of our business
      const n = await withTxn(null, false, (c) => c.query<{ n: number }>('SELECT animal.adopt_typed_kinds() AS n'));
      expect(n.rows[0]!.n).toBeGreaterThanOrEqual(3);
      const look = (w: number, member: string, id: number) => withTxn(w, true, (c) => getAnimal(c, id, member, T));
      expect(await look(W, me, budgie)).toMatchObject({ species: 'Budgerigar', ext: {} });
      expect(await look(W, me, gone)).toMatchObject({ species: 'Budgerigar', status: 'DECEASED' }); // kind is kind, whatever happened to the animal
      expect(await look(W2, bea, bunny)).toMatchObject({ species: 'Rabbit', module: 'rabbit', ext: {} });
      expect(await look(W, me, wild)).toMatchObject({ module: 'other', ext: { species_name: 'Robin' } });
      expect(await look(W, me, blank)).toMatchObject({ module: 'other', ext: { species_name: '!!!' } });
      expect(await look(W, me, goat)).toMatchObject({ species: 'Goat', ext: { species_name: 'Budgie' } });
      const again = await withTxn(null, false, (c) => c.query<{ n: number }>('SELECT animal.adopt_typed_kinds() AS n'));
      expect(again.rows[0]!.n).toBe(0);
    });

    it('re-saving an "Other animal" whose old kind can no longer be typed (legacy) is allowed when the kind is unchanged', async () => {
      const a = await add({ name: 'Legacy', species: 'Other animal', ext: { species_name: `Zz ${run}` } });
      await withTxn(W, false, (c) => c.query('UPDATE animal.animal SET ext = $1::jsonb WHERE animal_id = $2', [JSON.stringify({ species_name: '!!!' }), a.id]));
      expect(await withTxn(W, false, (c) => updateAnimal(c, a.id, me, { ext: { species_name: '!!!' } }, T))).toMatchObject({ module: 'other', ext: { species_name: '!!!' } });
    });

    it('leaves no household set on the connection afterwards', async () => {
      const r = await withTxn(null, false, async (c) => {
        await c.query('SELECT animal.adopt_typed_kinds()');
        return c.query<{ v: string | null }>("SELECT nullif(current_setting('app.current_workspace_id', true), '') AS v");
      });
      expect(r.rows[0]!.v).toBeNull();
    });
  });
});

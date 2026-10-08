#!/usr/bin/env node
// The content loader for About pages and species aliases (D2 spec sec 9.2). The ONLY code that writes ref.species_about and
// ref.species_alias: it sets `petopia.loader = on` inside its own transaction, which the write-guard triggers (migration 017) require.
// Run through the Axiom runner after `npm run build` (it imports the built validation code):
//   node scripts/load-about.mjs pages   [--dry-run] [--dir ../content/about]
//   node scripts/load-about.mjs aliases [--dry-run] [--file ../content/aliases.json]
//   node scripts/load-about.mjs retire "<common name>"
// Connects with PETOPIA_LOADER_DATABASE_URL, else PETOPIA_DATABASE_URL (engine/.env). Validates EVERYTHING first; one failure writes nothing.
import { readdir, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const { pageProblems, contentHash } = await import(join(here, '../dist/src/aboutpage.js'));

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const dry = flag('--dry-run');
const url = process.env.PETOPIA_LOADER_DATABASE_URL ?? process.env.PETOPIA_DATABASE_URL;
if (!url) { console.error('no PETOPIA_DATABASE_URL (source engine/.env first)'); process.exit(2); }
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function withLoader(fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('petopia.loader', 'on', true)");
    const out = await fn(c);
    await c.query(dry ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

async function pages() {
  const dir = opt('--dir', join(here, '../../content/about'));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const c0 = new pg.Client({ connectionString: url });
  await c0.connect();
  const loaded = [];
  const problems = [];
  try {
    for (const f of files) {
      let file;
      try { file = JSON.parse(await readFile(join(dir, f), 'utf8')); } catch { problems.push(`${f}: not valid JSON`); continue; }
      const r = await c0.query('SELECT species_id::text AS id, common_name, domain FROM ref.species WHERE common_name = $1', [file?.species]);
      const sp = r.rows[0] ?? null;
      const p = pageProblems(file, sp ? { common_name: sp.common_name, domain: sp.domain } : null);
      if (sp && f !== `${slug(sp.common_name)}.json`) p.push(`file name must be ${slug(sp.common_name)}.json`);
      if (p.length) for (const x of p) problems.push(`${f}: ${x}`);
      else loaded.push({ f, file, species_id: Number(sp.id), name: sp.common_name });
    }
  } finally { await c0.end(); }
  if (problems.length) { console.error(problems.join('\n')); console.error(`REFUSED: ${problems.length} problem(s); nothing written`); process.exit(1); }
  const out = await withLoader(async (c) => {
    const lines = [];
    for (const l of loaded) {
      const hash = contentHash(l.file);
      const live = (await c.query('SELECT about_id, content_hash FROM ref.species_about WHERE species_id = $1 AND retired_at IS NULL', [l.species_id])).rows[0];
      if (live && live.content_hash === hash) { lines.push(`UNCHANGED ${l.name}`); continue; }
      const max = (await c.query('SELECT COALESCE(max(version), 0) AS v FROM ref.species_about WHERE species_id = $1', [l.species_id])).rows[0].v;
      // retire first, then insert: the one-live-row index is not deferrable
      if (live) await c.query('UPDATE ref.species_about SET retired_at = now() WHERE about_id = $1', [live.about_id]);
      await c.query(
        'INSERT INTO ref.species_about (species_id, version, sections, checked_on, written_by, reviewed_by, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [l.species_id, Number(max) + 1, JSON.stringify(l.file.sections), l.file.checked_on, l.file.written_by, l.file.reviewed_by ?? null, hash]);
      lines.push(`${live ? 'UPDATED' : 'NEW'} ${l.name} (version ${Number(max) + 1})`);
    }
    return lines;
  });
  console.log(out.join('\n') || 'no page files');
  console.log(dry ? 'DRY RUN: nothing written' : 'done');
}

async function aliases() {
  const file = opt('--file', join(here, '../../content/aliases.json'));
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) { console.error('aliases file must be an object of species -> [aliases]'); process.exit(1); }
  if (Object.keys(data).length === 0) { console.error('REFUSED: the aliases file has no species in it (that would delete every alias)'); process.exit(1); }
  const out = await withLoader(async (c) => {
    const want = new Map(); // normalised alias -> species_id
    const problems = [];
    for (const [name, list] of Object.entries(data)) {
      const sp = (await c.query('SELECT species_id::text AS id, common_name FROM ref.species WHERE common_name = $1', [name])).rows[0];
      if (!sp) { problems.push(`unknown species "${name}"`); continue; }
      if (sp.common_name === 'Other animal') { problems.push(`"${name}" is the placeholder and cannot have aliases`); continue; }
      if (!Array.isArray(list) || list.length < 1 || list.length > 5 || list.some((a) => typeof a !== 'string')) { problems.push(`"${name}": give one to five alias strings`); continue; }
      for (const a of list) {
        const n = (await c.query('SELECT ref.normalise_kind($1) AS n', [a])).rows[0].n;
        if (!n) { problems.push(`alias "${a}" of "${name}" has no letters or numbers in it`); continue; }
        if (want.has(n) && want.get(n) !== Number(sp.id)) problems.push(`alias "${a}" is claimed by two species`);
        want.set(n, Number(sp.id));
      }
    }
    if (problems.length) throw new Error(`REFUSED: ${problems.join('; ')}`);
    const have = (await c.query('SELECT alias, species_id::text AS id FROM ref.species_alias')).rows;
    let removed = 0, added = 0;
    for (const h of have) if (want.get(h.alias) !== Number(h.id)) { await c.query('DELETE FROM ref.species_alias WHERE alias = $1', [h.alias]); removed++; }
    const keep = new Set(have.filter((h) => want.get(h.alias) === Number(h.id)).map((h) => h.alias));
    for (const [alias, id] of want) if (!keep.has(alias)) { await c.query('INSERT INTO ref.species_alias (alias, species_id) VALUES ($1, $2)', [alias, id]); added++; }
    const adopted = (await c.query('SELECT animal.adopt_typed_kinds() AS n')).rows[0].n;
    return `aliases: ${added} added, ${removed} removed, ${keep.size} unchanged; ${adopted} animal(s) switched`;
  });
  console.log(out);
  console.log(dry ? 'DRY RUN: nothing written' : 'done');
}

async function retire() {
  const name = args.slice(1).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--dir');
  if (!name) { console.error('usage: retire "<common name>" [--dir <folder>]'); process.exit(2); }
  const f = join(opt('--dir', join(here, '../../content/about')), `${slug(name)}.json`);
  if (await access(f).then(() => true, () => false)) { console.error(`REFUSED: ${f} still exists; remove the file first, or the next "pages" run would load it again`); process.exit(1); }
  const out = await withLoader(async (c) => {
    const sp = (await c.query('SELECT species_id FROM ref.species WHERE common_name = $1', [name])).rows[0];
    if (!sp) throw new Error(`REFUSED: there is no species called "${name}"`);
    const r = await c.query('UPDATE ref.species_about SET retired_at = now() WHERE retired_at IS NULL AND species_id = $1', [sp.species_id]);
    if (r.rowCount === 0) throw new Error(`REFUSED: ${name} has no live page to retire`);
    return `retired ${r.rowCount} live page(s) of ${name}`;
  });
  console.log(out);
}

if (cmd === 'pages') await pages();
else if (cmd === 'aliases') await aliases();
else if (cmd === 'retire') await retire();
else { console.error('usage: load-about.mjs pages|aliases|retire [--dry-run]'); process.exit(2); }

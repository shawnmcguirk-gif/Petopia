// About pages, slice A1 (D2 spec sec 3.4, 4.8): the researched page of a species, and "what does this typed kind resolve to".
// Reads only. The researched tables are written by the content loader (scripts/load-about.mjs), never by the engine.
// The AI-draft flow (typed kinds with no match) arrives in slice A3.
import { canAny } from './access.js';
import type { Client } from './db.js';
import { bad, notFound } from './errors.js';
import { guardSections, guardStatement, SECTIONS, type ShownSection } from './aboutguard.js';
import { sourceCount, type PageSection } from './aboutpage.js';

export interface SpeciesRef { id: number; common_name: string; scientific_name: string | null; domain: string; module_code: string | null }

export async function speciesById(c: Client, id: number): Promise<SpeciesRef | null> {
  const r = await c.query<{ species_id: string; common_name: string; scientific_name: string | null; domain: string; module_code: string | null }>(
    'SELECT species_id::text, common_name, scientific_name, domain, module_code FROM ref.species WHERE species_id = $1', [id]);
  const x = r.rows[0];
  return x ? { id: Number(x.species_id), common_name: x.common_name, scientific_name: x.scientific_name, domain: x.domain, module_code: x.module_code } : null;
}

/** The normalised form of a typed kind (the ONE definition lives in SQL: ref.normalise_kind). */
export async function normaliseKind(c: Client, typed: string): Promise<string> {
  return (await c.query<{ n: string }>('SELECT ref.normalise_kind($1) AS n', [typed])).rows[0]!.n;
}

/** sec 3.4 step 1 checks: the trimmed text is at most 80 characters and so is its normalised form; empty after normalising is refused. */
export async function checkTypedKind(c: Client, typed: unknown): Promise<{ text: string; key: string }> {
  if (typeof typed !== 'string') throw bad('say what kind of animal it is');
  const text = typed.trim();
  if (!text) throw bad('say what kind of animal it is');
  if (text.length > 80) throw bad('the kind of animal can be at most 80 characters');
  const key = await normaliseKind(c, text);
  if (!key) throw bad('say what kind of animal it is, using letters or numbers');
  if (key.length > 80) throw bad('the kind of animal can be at most 80 characters');
  return { text, key };
}

/** sec 3.4 steps 1 to 2: the species a typed kind names (name, alias, then the same minus one trailing "s"), or null. */
export async function resolveKind(c: Client, typed: string): Promise<SpeciesRef | null> {
  const r = await c.query<{ id: string | null }>('SELECT ref.resolve_kind($1)::text AS id', [typed]);
  const id = r.rows[0]?.id;
  return id ? speciesById(c, Number(id)) : null;
}

export type SpeciesPage =
  | { state: 'NONE' }
  | {
      state: 'PAGE';
      species: { id: number; common_name: string; scientific_name: string | null; domain: string };
      version: number; checked_on: string; written_by: string; reviewed_by: string | null; source_count: number;
      headings: Record<string, string>;
      sections: Record<string, ShownSection>;
    };

/** The live researched page of a species, after the display-time guard (sec 6.5). */
export async function getSpeciesPage(c: Client, speciesId: number): Promise<SpeciesPage> {
  const sp = await speciesById(c, speciesId);
  if (!sp) throw notFound('no such species');
  const r = await c.query<{ version: number; sections: Record<string, PageSection>; checked_on: string; written_by: string; reviewed_by: string | null }>(
    'SELECT version, sections, checked_on::text, written_by, reviewed_by FROM ref.species_about WHERE species_id = $1 AND retired_at IS NULL', [speciesId]);
  const row = r.rows[0];
  if (!row) return { state: 'NONE' };
  const headings: Record<string, string> = Object.fromEntries(SECTIONS.map((s) => [s.key, s.heading]));
  if (sp.domain === 'WILD') headings.housing = 'Habitat';
  return {
    state: 'PAGE',
    species: { id: sp.id, common_name: sp.common_name, scientific_name: sp.scientific_name, domain: sp.domain },
    version: row.version, checked_on: row.checked_on, written_by: row.written_by,
    reviewed_by: row.reviewed_by && row.reviewed_by.length <= 80 && !guardStatement(row.reviewed_by, 'RESEARCHED') ? row.reviewed_by : null, // shown as "Read by …"
    source_count: sourceCount(row.sections), headings, sections: guardSections(row.sections, 'RESEARCHED'),
  };
}

/** species_id -> true for every species with a live page (the picker's "has_about"). */
export async function speciesWithPages(c: Client): Promise<Set<number>> {
  const r = await c.query<{ species_id: string }>('SELECT species_id::text FROM ref.species_about WHERE retired_at IS NULL');
  return new Set(r.rows.map((x) => Number(x.species_id)));
}

export interface AboutKind {
  tier: 'SPECIES' | 'NONE';
  species?: { id: number; common_name: string; domain: string; has_page: boolean };
  wild?: boolean;
  /** true if this member holds ADD_MEDIA on at least one animal. In A1 nothing can be written yet, so the web shows no button. */
  can_write: boolean;
}

/** GET about/kind?name=: what a typed kind resolves to (sec 3.4). Writes nothing. draft / my_consent arrive in A3. */
export async function aboutKind(c: Client, member: string, name: unknown): Promise<AboutKind> {
  const { text } = await checkTypedKind(c, name);
  const can_write = await canAny(c, member, 'ADD_MEDIA');
  const sp = await resolveKind(c, text);
  if (!sp) return { tier: 'NONE', can_write };
  const has = (await getSpeciesPage(c, sp.id)).state === 'PAGE';
  return { tier: 'SPECIES', species: { id: sp.id, common_name: sp.common_name, domain: sp.domain, has_page: has }, wild: sp.domain === 'WILD', can_write };
}

// A researched About page file (D2 spec sec 9.1 / 9.2 / Appendix B.3): shape (ajv, schemas/about/page.json), the rules that
// depend on the species, and the content hash the loader uses. Pure: the loader script and the tests share it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import { guardStatement, type Source } from './aboutguard.js';

export interface PageSection { statements: string[]; sources: Source[] }
export interface PageFile {
  species: string;
  checked_on: string;
  written_by: string;
  reviewed_by?: string;
  sections: Record<string, PageSection>;
}

/** Sections every species must have, and the extra one for pets (sec 2). */
export const REQUIRED_ALWAYS = ['summary', 'characteristics', 'habits', 'diet', 'housing', 'lifespan', 'breeding'] as const;
export const NEEDS_TWO_PUBLISHERS = ['breeding', 'health'] as const;

let validate: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
  if (!validate) {
    // src/ (tests, tsx) and dist/src/ (built) sit at different depths under engine/.
    const here = [new URL('../schemas/about/page.json', import.meta.url), new URL('../../schemas/about/page.json', import.meta.url)].find((u) => existsSync(u));
    if (!here) throw new Error('schemas/about/page.json not found');
    const schema = JSON.parse(readFileSync(here, 'utf8')) as Record<string, unknown>;
    validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  }
  return validate;
}

const TODAY = (): string => new Date().toISOString().slice(0, 10);
const isRealDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const publisherKey = (p: string): string => p.trim().toLowerCase();
const longQuote = (t: string): boolean => [...t.matchAll(/["“]([^"”]*)["”]/g)].some((m) => (m[1] ?? '').trim().split(/\s+/).filter(Boolean).length > 25);

/** Every problem with one page file for a species with this name and domain; empty when the file may be loaded. */
export function pageProblems(file: unknown, species: { common_name: string; domain: string } | null, today = TODAY()): string[] {
  const v = schemaValidator();
  if (!v(file)) return (v.errors ?? []).slice(0, 12).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is not valid'}`);
  const f = file as PageFile;
  const p: string[] = [];
  if (!species) return [`there is no species called "${f.species}" in ref.species`];
  if (f.species !== species.common_name) p.push(`species must equal "${species.common_name}" exactly`);
  if (!isRealDate(f.checked_on) || f.checked_on > today) p.push('checked_on must be a real date, not after today');
  const need: string[] = [...REQUIRED_ALWAYS];
  if (species.domain === 'PET' || species.domain === 'BOTH') need.push('health');
  for (const k of need) if (!f.sections[k]) p.push(`section ${k} is required for this species`);
  for (const [k, s] of Object.entries(f.sections)) {
    for (const [i, t] of s.statements.entries()) {
      if ([...t].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) p.push(`${k} statement ${i + 1} contains a control character`);
      const hit = guardStatement(t, 'RESEARCHED', k);
      if (hit) p.push(`${k} statement ${i + 1} is refused by guard rule ${hit}`);
      if (longQuote(t)) p.push(`${k} statement ${i + 1} quotes more than 25 words`);
    }
    for (const [i, src] of s.sources.entries()) {
      if (!isRealDate(src.checked_on) || src.checked_on > f.checked_on || src.checked_on > today) p.push(`${k} source ${i + 1}: checked_on must be a real date, not after the page's checked_on or today`);
    }
    if ((NEEDS_TWO_PUBLISHERS as readonly string[]).includes(k) && new Set(s.sources.map((x) => publisherKey(x.publisher))).size < 2) {
      p.push(`${k} needs sources from at least two different publishers`);
    }
  }
  return p;
}

/** Distinct source links across a page. Tolerates a malformed stored row (the display-time guard shows what it can). */
export function sourceCount(sections: unknown): number {
  if (typeof sections !== 'object' || sections === null) return 0;
  const urls = new Set<string>();
  for (const s of Object.values(sections as Record<string, unknown>)) {
    const list = (s as { sources?: unknown } | null)?.sources;
    if (!Array.isArray(list)) continue;
    for (const x of list) { const u = (x as { url?: unknown } | null)?.url; if (typeof u === 'string') urls.add(u); }
  }
  return urls.size;
}

/** Canonical JSON: keys sorted at every depth, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** sha256 over the canonical JSON of what is stored: the sections, checked_on, written_by and reviewed_by (sec 3.2). */
export function contentHash(f: PageFile): string {
  return createHash('sha256').update(canonicalJson({ sections: f.sections, checked_on: f.checked_on, written_by: f.written_by, reviewed_by: f.reviewed_by ?? null })).digest('hex');
}

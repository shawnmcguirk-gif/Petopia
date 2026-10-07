// The quote guard (spec sec 5.2 "Guard"), the rules of Vitalis import.ts L7/L8 applied to Petopia's reader answer.
// Pure: no database, no model. Given the ajv-checked answer and the engine's OWN text of each page:
//   - a value whose quote is not found on its page (after the same normalising as Vitalis normText) is DROPPED;
//   - a value with a number that is not a whole numeric token of its quote is DROPPED ("every number must be in its
//     quote": a model cannot put 61 on screen when the page says 6.1);
//   - a fact whose fields do not fit its kind (unknown field, wrong type) is DROPPED;
//   - a quote shorter than MIN_QUOTE characters is DROPPED (a "." or an "e" is found on any page and proves nothing; a
//     real short quote such as "6kg" or "6.1 kg" passes -- the value checks below do the real work);
//   - a weight whose UNIT is not a whole word of its quote is DROPPED ("6.1 kg" against a quote saying "6.1 lb");
//   - a text value (a vaccine, a condition, a vet's name ...) must be in its quote as whole words (normalised,
//     case-insensitive: "Cat" is not in "Category"; enum codes such as ROUTINE / ACTIVE are the reader's labels, not
//     printed text). One that is not is BLANKED and the fact FLAGGED FIELD_NOT_IN_QUOTE for a person to check; only
//     when a REQUIRED field is blanked is the whole fact DROPPED (VALUE_NOT_IN_QUOTE);
//   - a date must have its day, month and year in its quote (02/10/2026, 2 Oct 2026, 2026-10-02 ...). When the quote's
//     numbers could be day/month OR month/day (03/10/2026), the value is FLAGGED DATE_ORDER_AMBIGUOUS for a person to
//     check, never passed silently; a date whose day or month is not in the quote is flagged DATE_NOT_IN_QUOTE (a fact)
//     or dropped (the document date);
// and every drop is COUNTED (inbox_item.dropped_count, extraction_run.dropped) with a reason code, never the text.
// Nothing that survives is a fact yet: it becomes a proposal a person must accept.
import { Ajv, type ValidateFunction } from 'ajv';
import { Decimal } from 'decimal.js';
import type { PageText } from './extract.js';
import { FACT_FIELDS, type FactKind, type ReaderAnswer } from './reader.js';

/** NFKC, curly quotes straight, dashes and minus to '-', whitespace runs to one space, trimmed. (Vitalis normText.) */
export function normText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Whole numeric tokens, as numbers ("6.10 kg" -> "6.1"; "03/10/2026" -> "3", "10", "2026"). A thousands comma is joined first. */
export function numTokens(s: string): string[] {
  return (s.replace(/(\d),(\d{3})\b/g, '$1$2').match(/\d+(?:[.,]\d+)?/g) ?? []).map((t) => new Decimal(t.replace(',', '.')).toString());
}
const numOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number') return 'NaN';
  try {
    return new Decimal(String(v).trim().replace(/^[€£$]/, '').replace(',', '.')).toString();
  } catch {
    return 'NaN';
  }
};

/** Fields that hold a number the guard must find in the quote. */
const NUMBER_FIELDS = new Set(['value', 'dose_amount', 'quantity_supplied', 'amount']);
const DATE_FIELDS = new Set(['visit_on', 'follow_up_on', 'given_on', 'next_due_on', 'first_noted_on', 'performed_on', 'sampled_on', 'event_on', 'on']);
/** Coded fields: the reader's label from a fixed list, not words printed on the page. `unit` is checked by unitIn. */
const CODE_FIELDS = new Set(['kind', 'condition_status', 'certainty', 'substance_kind', 'unit']);
/** A quote shorter than this proves nothing (finding: "Cancer" passed with the quote "."). */
export const MIN_QUOTE = 3;

const S = { type: ['string', 'null'], maxLength: 400 };
const D = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const N = { type: ['string', 'number', 'null'] };
const E = (values: string[]) => ({ type: ['string', 'null'], enum: [...values, null] });
const SPECIAL: Record<string, object> = {
  kind: S, condition_status: E(['SUSPECTED', 'ACTIVE', 'RESOLVED']), certainty: E(['CONFIRMED_BY_VET', 'SUSPECTED']),
  substance_kind: E(['FOOD', 'DRUG', 'ENVIRONMENT', 'OTHER']), unit: E(['kg', 'g', 'lb']), value: N, dose_amount: N, quantity_supplied: N,
};
const KIND_ENUM: Partial<Record<FactKind, string[]>> = { vet_visit: ['ROUTINE', 'ILLNESS', 'EMERGENCY', 'SURGERY', 'REFERRAL', 'FOLLOW_UP'], treatment: ['FLEA', 'WORM', 'TICK', 'DENTAL', 'OTHER'] };
const REQUIRED: Partial<Record<FactKind, string[]>> = { vaccination: ['vaccine'], condition: ['name'], allergy: ['substance'], procedure: ['name'], lab_result: ['test'], medication: ['product_name'], weight: ['value', 'unit'], treatment: ['kind'] };

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
/** The strict per-kind schema the reader's fields (and a person's corrections) must fit. */
export function fieldSchema(kind: FactKind): Record<string, unknown> {
  const properties: Record<string, object> = {};
  for (const f of FACT_FIELDS[kind]) properties[f] = f === 'kind' && KIND_ENUM[kind] ? E(KIND_ENUM[kind]) : DATE_FIELDS.has(f) ? D : SPECIAL[f] ?? S;
  return { type: 'object', additionalProperties: false, properties, required: REQUIRED[kind] ?? [] };
}
const validators = new Map<FactKind, ValidateFunction>();
export function fieldsFit(kind: FactKind, fields: unknown): boolean {
  let v = validators.get(kind);
  if (!v) { v = ajv.compile(fieldSchema(kind)); validators.set(kind, v); }
  if (!v(fields)) return false;
  const req = REQUIRED[kind] ?? [];
  return req.every((k) => { const x = (fields as Record<string, unknown>)[k]; return x !== null && x !== undefined && (typeof x !== 'string' || x.trim() !== ''); });
}

export type DropReason = 'QUOTE_NOT_ON_PAGE' | 'QUOTE_TOO_SHORT' | 'NUMBER_NOT_IN_QUOTE' | 'VALUE_NOT_IN_QUOTE' | 'UNIT_NOT_IN_QUOTE' | 'DATE_NOT_IN_QUOTE' | 'FIELDS_INVALID' | 'NO_SUCH_PAGE';
export interface GuardedFact { kind: FactKind | 'contact'; page: number; quote: string; fields: Record<string, string | number | null>; flags: string[] }
export interface Guarded {
  is_pet_document: boolean;
  doc_kind: string;
  animal: { name: string | null; species: string | null; microchip: string | null };
  document_date: string | null;
  facts: GuardedFact[];
  dropped: number;
  reasons: DropReason[];
  flags: string[];
  found: Record<string, unknown>; // for step 1: what was read, each with page + quote
}

/** Does `quote` appear on `page`? Returns a drop reason or null. */
function quoteOk(pages: Map<number, string>, page: number | null, quote: string | null): DropReason | null {
  if (!page || !quote) return 'QUOTE_NOT_ON_PAGE';
  const text = pages.get(page);
  if (text === undefined) return 'NO_SUCH_PAGE';
  const q = normText(quote);
  if (q.length < MIN_QUOTE) return 'QUOTE_TOO_SHORT';
  return text.includes(q) ? null : 'QUOTE_NOT_ON_PAGE';
}
/** Every number in these fields must be a whole token of the quote. */
function numbersOk(fields: Record<string, unknown>, quote: string): boolean {
  const tokens = new Set(numTokens(normText(quote)));
  for (const [k, v] of Object.entries(fields)) {
    if (!NUMBER_FIELDS.has(k)) continue;
    const n = numOf(v);
    if (n !== null && !tokens.has(n)) return false;
  }
  // a lab value as printed: its numbers too
  if (typeof fields.value_printed === 'string') for (const t of numTokens(fields.value_printed)) if (!tokens.has(t)) return false;
  return true;
}
const lc = (x: string): string => normText(x).toLowerCase();
const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Is `value` in `quote` as whole words (normalised, case-insensitive)? "Feline enteritis" yes; "Cat" in "Category" no. */
export function wordsIn(value: string, quote: string): boolean {
  const v = lc(value);
  if (!v) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, 'u').test(lc(quote));
}
/** The text fields whose value is NOT in the quote. Numbers, dates and coded fields are checked elsewhere. */
function textsMissing(fields: Record<string, unknown>, quote: string): string[] {
  return Object.entries(fields)
    .filter(([k, v]) => typeof v === 'string' && !NUMBER_FIELDS.has(k) && !DATE_FIELDS.has(k) && !CODE_FIELDS.has(k) && !wordsIn(v, quote))
    .map(([k]) => k);
}
/** The ways a weight unit is printed. The unit must be a whole word of the quote ("6.1kg" counts; "kg" is not "g"). */
const UNIT_WORDS: Record<string, string[]> = {
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'],
  g: ['g', 'gm', 'gms', 'gram', 'grams', 'gramme', 'grammes'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
};
export function unitIn(unit: string, quote: string): boolean {
  const words = UNIT_WORDS[unit.toLowerCase()] ?? [unit.toLowerCase()];
  return words.some((w) => new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'u').test(lc(quote)));
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (word: string): number | null => {
  const w = word.toLowerCase().slice(0, 3);
  const i = MONTH_NAMES.indexOf(w === 'sept' ? 'sep' : w);
  return i < 0 ? null : i + 1;
};
const fullYear = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));
export type DateCheck = 'OK' | 'AMBIGUOUS' | 'MISSING';
/**
 * Is the date (YYYY-MM-DD) printed in the quote, with its day, month and year? Pure.
 *   OK         an unambiguous match: 2026-10-03, 3 Oct 2026, October 3rd 2026, 25/10/2026 (25 cannot be a month);
 *   AMBIGUOUS  only a numeric date whose first two numbers could be either way round (03/10/2026 is 3 Oct in Ireland,
 *              10 Mar in the US) -- whichever reading the value took, a person checks it (finding: day/month swap);
 *   MISSING    no date in the quote carries this day, month and year.
 */
export function dateIn(date: string, quote: string): DateCheck {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 'MISSING';
  const [Y, M, D] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const q = lc(quote);
  let ambiguous = false;
  for (const x of q.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) if (Number(x[1]) === Y && Number(x[2]) === M && Number(x[3]) === D) return 'OK';
  for (const x of q.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g)) {
    const [a, b, y] = [Number(x[1]), Number(x[2]), fullYear(x[3]!)];
    if (y !== Y) continue;
    const dm = a === D && b === M; // day/month (Irish)
    const md = a === M && b === D; // month/day (US)
    if (!dm && !md) continue;
    if (a === b || a > 12 || b > 12) return 'OK'; // only one reading is possible
    ambiguous = true;
  }
  const MON = '([a-z]{3,9})\\.?';
  for (const x of q.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?[\\s-]+${MON},?[\\s-]+(\\d{4}|'?\\d{2})(?!\\d)`, 'g'))) {
    if (Number(x[1]) === D && monthOf(x[2]!) === M && fullYear(x[3]!.replace("'", '')) === Y) return 'OK';
  }
  for (const x of q.matchAll(new RegExp(`${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'g'))) {
    if (monthOf(x[1]!) === M && Number(x[2]) === D && Number(x[3]) === Y) return 'OK';
  }
  return ambiguous ? 'AMBIGUOUS' : 'MISSING';
}

export function guardAnswer(a: ReaderAnswer, pageTexts: PageText[]): Guarded {
  const pages = new Map(pageTexts.map((p) => [p.page, normText(p.text)]));
  const reasons: DropReason[] = [];
  const flags: string[] = [];
  const drop = (r: DropReason) => { reasons.push(r); };
  const found: Record<string, unknown> = {};

  // the animal as printed: name / species / microchip survive only with a quote on the page; the microchip's digits must be in it
  const animal = { name: null as string | null, species: null as string | null, microchip: null as string | null };
  if (a.animal.name || a.animal.microchip || a.animal.species) {
    const r = quoteOk(pages, a.animal.page, a.animal.quote);
    if (r) drop(r);
    else {
      const q = normText(a.animal.quote!).toLowerCase().replace(/\s+/g, '');
      if (a.animal.name && q.includes(a.animal.name.toLowerCase().replace(/\s+/g, ''))) animal.name = a.animal.name.trim();
      else if (a.animal.name) drop('VALUE_NOT_IN_QUOTE');
      animal.species = a.animal.species?.trim() || null;
      const chip = (a.animal.microchip ?? '').replace(/\s+/g, '');
      if (chip) {
        if (q.includes(chip.toLowerCase())) animal.microchip = chip;
        else drop('NUMBER_NOT_IN_QUOTE');
      }
      found.animal = { ...animal, page: a.animal.page, quote: a.animal.quote };
    }
  }

  let documentDate: string | null = null;
  if (a.document_date.value) {
    const r = quoteOk(pages, a.document_date.page, a.document_date.quote);
    const dc = r ? 'MISSING' : dateIn(a.document_date.value, a.document_date.quote!);
    if (r || dc === 'MISSING') drop(r ?? 'DATE_NOT_IN_QUOTE');
    else {
      documentDate = a.document_date.value;
      // day/month or month/day? the person sets the date at step 1 (inbox.ts decide)
      if (dc === 'AMBIGUOUS') flags.push('DATE_ORDER_AMBIGUOUS');
      found.document_date = { value: documentDate, page: a.document_date.page, quote: a.document_date.quote, ambiguous: dc === 'AMBIGUOUS' };
    }
  }

  const facts: GuardedFact[] = [];
  if (a.provider.name) {
    const r = quoteOk(pages, a.provider.page, a.provider.quote);
    if (r) drop(r);
    else if (!wordsIn(a.provider.name, a.provider.quote!)) drop('VALUE_NOT_IN_QUOTE');
    else {
      const phoneOk = !a.provider.phone || numTokens(a.provider.phone).every((t) => numTokens(normText(a.provider.quote!)).includes(t));
      const fields = { name: a.provider.name.trim().slice(0, 120), phone: phoneOk ? a.provider.phone : null };
      facts.push({ kind: 'contact', page: a.provider.page!, quote: a.provider.quote!, fields, flags: phoneOk ? [] : ['PHONE_NOT_IN_QUOTE'] });
      found.provider = { ...fields, page: a.provider.page, quote: a.provider.quote };
    }
  }

  for (const f of a.facts) {
    const fields: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(f.fields)) if (v !== null && v !== '') fields[k] = typeof v === 'string' ? v.trim() : v;
    if (!fieldsFit(f.kind, fields)) { drop('FIELDS_INVALID'); continue; }
    const r = quoteOk(pages, f.page, f.quote);
    if (r) { drop(r); continue; }
    if (!numbersOk(fields, f.quote)) { drop('NUMBER_NOT_IN_QUOTE'); continue; }
    if (f.kind === 'weight' && (typeof fields.unit !== 'string' || !unitIn(fields.unit, f.quote))) { drop('UNIT_NOT_IN_QUOTE'); continue; }
    const ff: string[] = [];
    const missing = textsMissing(fields, f.quote);
    if (missing.length) {
      // blank only what the quote does not show; a fact that then lacks a required field is dropped
      for (const k of missing) delete fields[k];
      if (!fieldsFit(f.kind, fields)) { drop('VALUE_NOT_IN_QUOTE'); continue; }
      ff.push('FIELD_NOT_IN_QUOTE');
    }
    for (const [k, v] of Object.entries(fields)) {
      if (!DATE_FIELDS.has(k) || typeof v !== 'string') continue;
      const dc = dateIn(v, f.quote);
      if (dc === 'MISSING') ff.push('DATE_NOT_IN_QUOTE');
      else if (dc === 'AMBIGUOUS') ff.push('DATE_ORDER_AMBIGUOUS');
    }
    facts.push({ kind: f.kind, page: f.page, quote: f.quote, fields, flags: [...new Set(ff)] });
  }

  // costs: each line and the total need their quote and number; lines must add up to the total within 2 cent, or the
  // invoice is flagged -- never silently fixed (sec 5.2 item 9, Epicure sec 6.9). The total goes on the vet visit.
  const lines: { description: string | null; amount: string; page: number; quote: string }[] = [];
  for (const l of a.costs.lines) {
    const r = quoteOk(pages, l.page, l.quote);
    const n = numOf(l.amount);
    if (r) { drop(r); continue; }
    if (n === null || n === 'NaN' || !numTokens(normText(l.quote)).includes(n)) { drop('NUMBER_NOT_IN_QUOTE'); continue; }
    lines.push({ description: l.description, amount: new Decimal(n).toFixed(2), page: l.page, quote: l.quote });
  }
  let total: string | null = null;
  const tn = numOf(a.costs.total.amount);
  if (tn !== null) {
    const r = quoteOk(pages, a.costs.total.page, a.costs.total.quote);
    if (r) drop(r);
    else if (tn === 'NaN' || !numTokens(normText(a.costs.total.quote!)).includes(tn)) drop('NUMBER_NOT_IN_QUOTE');
    else total = new Decimal(tn).toFixed(2);
  }
  if (total !== null && lines.length > 0) {
    const sum = lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
    if (sum.minus(total).abs().greaterThan('0.02')) flags.push('INVOICE_TOTAL_MISMATCH');
  }
  if (total !== null || lines.length) {
    found.costs = { currency: a.costs.currency ?? 'EUR', total, total_page: a.costs.total.page, total_quote: a.costs.total.quote, lines };
    const visit = facts.find((x) => x.kind === 'vet_visit');
    if (visit && total !== null) {
      visit.fields.cost_amount = total;
      visit.fields.cost_currency = a.costs.currency ?? 'EUR';
      if (flags.includes('INVOICE_TOTAL_MISMATCH')) visit.flags.push('INVOICE_TOTAL_MISMATCH');
    }
  }

  if (!documentDate) flags.push('DATE_ASSUMED');
  return { is_pet_document: a.is_pet_document, doc_kind: a.doc_kind, animal, document_date: documentDate, facts, dropped: reasons.length, reasons, flags, found };
}

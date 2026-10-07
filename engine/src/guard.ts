// The quote guard (spec sec 5.2 "Guard"), the rules of Vitalis import.ts L7/L8 applied to Petopia's reader answer.
// Pure: no database, no model. Given the ajv-checked answer and the engine's OWN text of each page:
//   - a value whose quote is not found on its page (after the same normalising as Vitalis normText) is DROPPED;
//   - a value with a number that is not a whole numeric token of its quote is DROPPED ("every number must be in its
//     quote": a model cannot put 61 on screen when the page says 6.1);
//   - a fact whose fields do not fit its kind (unknown field, wrong type) is DROPPED;
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

export type DropReason = 'QUOTE_NOT_ON_PAGE' | 'NUMBER_NOT_IN_QUOTE' | 'VALUE_NOT_IN_QUOTE' | 'FIELDS_INVALID' | 'NO_SUCH_PAGE';
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
  return text.includes(normText(quote)) ? null : 'QUOTE_NOT_ON_PAGE';
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
/** A date is "in" its quote when its year is a token there (day/month order is the reader's to get right; a person checks). */
const dateYearIn = (date: string, quote: string): boolean => {
  const toks = new Set(numTokens(normText(quote)));
  return toks.has(String(Number(date.slice(0, 4)))) || toks.has(String(Number(date.slice(2, 4))));
};

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
    if (r || !dateYearIn(a.document_date.value, a.document_date.quote!)) drop(r ?? 'NUMBER_NOT_IN_QUOTE');
    else { documentDate = a.document_date.value; found.document_date = { value: documentDate, page: a.document_date.page, quote: a.document_date.quote }; }
  }

  const facts: GuardedFact[] = [];
  if (a.provider.name) {
    const r = quoteOk(pages, a.provider.page, a.provider.quote);
    if (r) drop(r);
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
    const ff: string[] = [];
    for (const [k, v] of Object.entries(fields)) if (DATE_FIELDS.has(k) && typeof v === 'string' && !dateYearIn(v, f.quote)) ff.push('DATE_NOT_IN_QUOTE');
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

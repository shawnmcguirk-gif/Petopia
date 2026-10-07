// The vet record kinds as the forms and lists show them (mirrors engine/src/records.ts KINDS; the engine validates).
import { niceDate } from './format';

// Words only for codes the engine stores -- no health status or diagnosis is ever produced here.
export type FieldType = 'text' | 'long' | 'vdate' | 'date' | 'enum' | 'money' | 'contact' | 'visit';
export interface FieldDef { name: string; label: string; type: FieldType; options?: [string, string][]; required?: boolean; hint?: string }
export interface KindDef { code: string; title: string; one: string; fields: FieldDef[]; date: string; headline: (f: Record<string, unknown>) => string; lines: (f: Record<string, unknown>) => string[] }

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const VISIT_KINDS: [string, string][] = [['ROUTINE', 'Routine'], ['ILLNESS', 'Illness'], ['EMERGENCY', 'Emergency'], ['SURGERY', 'Surgery'], ['REFERRAL', 'Referral'], ['FOLLOW_UP', 'Follow-up']];
const TREATMENT_KINDS: [string, string][] = [['FLEA', 'Flea'], ['WORM', 'Worming'], ['TICK', 'Tick'], ['DENTAL', 'Dental'], ['OTHER', 'Other']];
const CONDITION_STATUS: [string, string][] = [['ACTIVE', 'Ongoing'], ['SUSPECTED', 'Suspected'], ['RESOLVED', 'Resolved']];
const CERTAINTY: [string, string][] = [['SUSPECTED', 'We suspect it'], ['CONFIRMED_BY_VET', 'Confirmed by the vet']];
const SUBSTANCE: [string, string][] = [['FOOD', 'Food'], ['DRUG', 'Medicine'], ['ENVIRONMENT', 'Environment'], ['OTHER', 'Other']];
export const words = (opts: [string, string][], v: unknown): string => opts.find((o) => o[0] === v)?.[1] ?? s(v);
const VD = 'e.g. 2025-10-03, or just 2025-10 or 2025';

export const KINDS: KindDef[] = [
  {
    code: 'vet_visit', title: 'Vet visits', one: 'Vet visit', date: 'visit_on',
    fields: [
      { name: 'visit_on', label: 'Date', type: 'vdate', required: true, hint: VD },
      { name: 'kind', label: 'Kind of visit', type: 'enum', options: VISIT_KINDS },
      { name: 'contact_id', label: 'Clinic', type: 'contact' },
      { name: 'vet_name', label: 'Vet seen', type: 'text' },
      { name: 'reason', label: 'Reason', type: 'text' },
      { name: 'symptoms', label: 'Symptoms', type: 'long' },
      { name: 'examination', label: 'Examination', type: 'long' },
      { name: 'diagnosis_text', label: 'Diagnosis (as the vet said or wrote it)', type: 'long' },
      { name: 'treatment_text', label: 'Treatment', type: 'long' },
      { name: 'follow_up_on', label: 'Follow-up on', type: 'date' },
      { name: 'cost_amount', label: 'Cost (€)', type: 'money' },
      { name: 'notes', label: 'Notes', type: 'long' },
    ],
    headline: (f) => s(f.reason) || words(VISIT_KINDS, f.kind) + ' visit',
    lines: (f) => [s(f.vet_name), f.diagnosis_text ? `Diagnosis: ${s(f.diagnosis_text)}` : '', f.treatment_text ? `Treatment: ${s(f.treatment_text)}` : '',
      f.follow_up_on ? `Follow-up ${niceDate(s(f.follow_up_on))}` : '', f.cost_amount ? `€${s(f.cost_amount)}` : ''].filter(Boolean),
  },
  {
    code: 'vaccination', title: 'Vaccinations', one: 'Vaccination', date: 'given_on',
    fields: [
      { name: 'vaccine', label: 'Vaccine', type: 'text', required: true },
      { name: 'given_on', label: 'Given on', type: 'vdate', required: true, hint: VD },
      { name: 'next_due_on', label: 'Next due (if the vet gave one)', type: 'date' },
      { name: 'batch', label: 'Batch', type: 'text' },
      { name: 'vet_visit_id', label: 'At vet visit', type: 'visit' },
      { name: 'notes', label: 'Notes', type: 'long' },
    ],
    headline: (f) => s(f.vaccine), lines: (f) => [f.next_due_on ? `Next due ${niceDate(s(f.next_due_on))}` : ''].filter(Boolean),
  },
  {
    code: 'treatment', title: 'Flea, worm and other treatments', one: 'Treatment', date: 'given_on',
    fields: [
      { name: 'kind', label: 'Kind', type: 'enum', options: TREATMENT_KINDS, required: true },
      { name: 'product', label: 'Product', type: 'text' },
      { name: 'given_on', label: 'Given on', type: 'vdate', required: true, hint: VD },
      { name: 'next_due_on', label: 'Next due', type: 'date' },
      { name: 'vet_visit_id', label: 'At vet visit', type: 'visit' },
      { name: 'notes', label: 'Notes', type: 'long' },
    ],
    headline: (f) => `${words(TREATMENT_KINDS, f.kind)}${f.product ? ` · ${s(f.product)}` : ''}`, lines: (f) => [f.next_due_on ? `Next due ${niceDate(s(f.next_due_on))}` : ''].filter(Boolean),
  },
  {
    code: 'condition', title: 'Conditions', one: 'Condition', date: 'first_noted_on',
    fields: [
      { name: 'name', label: 'Condition', type: 'text', required: true },
      { name: 'condition_status', label: 'Status', type: 'enum', options: CONDITION_STATUS },
      { name: 'first_noted_on', label: 'First noticed', type: 'vdate', hint: VD },
      { name: 'vet_visit_id', label: 'At vet visit', type: 'visit' },
      { name: 'notes', label: 'Notes', type: 'long' },
    ],
    headline: (f) => s(f.name), lines: (f) => [words(CONDITION_STATUS, f.condition_status)],
  },
  {
    code: 'allergy', title: 'Allergies', one: 'Allergy', date: 'noted_on',
    fields: [
      { name: 'substance', label: 'Allergic to', type: 'text', required: true },
      { name: 'substance_kind', label: 'Kind', type: 'enum', options: SUBSTANCE },
      { name: 'reaction', label: 'Reaction', type: 'text' },
      { name: 'certainty', label: 'How sure', type: 'enum', options: CERTAINTY },
      { name: 'noted_on', label: 'Noticed', type: 'vdate', hint: VD },
      { name: 'notes', label: 'Notes', type: 'long' },
    ],
    headline: (f) => s(f.substance), lines: (f) => [s(f.reaction), words(CERTAINTY, f.certainty)].filter(Boolean),
  },
  {
    code: 'procedure', title: 'Procedures', one: 'Procedure', date: 'performed_on',
    fields: [
      { name: 'name', label: 'Procedure', type: 'text', required: true },
      { name: 'performed_on', label: 'Date', type: 'vdate', required: true, hint: VD },
      { name: 'vet_visit_id', label: 'At vet visit', type: 'visit' },
      { name: 'outcome', label: 'Outcome', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'long' },
    ],
    headline: (f) => s(f.name), lines: (f) => [s(f.outcome)].filter(Boolean),
  },
  {
    code: 'lab_result', title: 'Lab results', one: 'Lab result', date: 'sampled_on',
    fields: [
      { name: 'test', label: 'Test', type: 'text', required: true },
      { name: 'analyte', label: 'What was measured', type: 'text' },
      { name: 'value_printed', label: 'Result (as printed)', type: 'text' },
      { name: 'unit_printed', label: 'Unit (as printed)', type: 'text' },
      { name: 'ref_range_printed', label: 'Reference range (as printed)', type: 'text' },
      { name: 'flag_printed', label: 'Flag (as printed, e.g. H or L)', type: 'text' },
      { name: 'sampled_on', label: 'Sample date', type: 'vdate', required: true, hint: VD },
      { name: 'vet_visit_id', label: 'At vet visit', type: 'visit' },
      { name: 'notes', label: 'Notes', type: 'long' },
    ],
    headline: (f) => `${s(f.test)}${f.analyte ? `: ${s(f.analyte)}` : ''}`,
    lines: (f) => [[s(f.value_printed), s(f.unit_printed), f.flag_printed ? `(${s(f.flag_printed)})` : ''].filter(Boolean).join(' '), f.ref_range_printed ? `Range on the report: ${s(f.ref_range_printed)}` : ''].filter(Boolean),
  },
];

export const SOURCES: [string, string][] = [['OWNER_OBSERVATION', 'Our note'], ['VET_RECORD', 'Vet record'], ['VET_ADVICE', 'Vet advice']];

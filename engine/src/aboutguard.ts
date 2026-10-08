// The About-page guards (D2 spec sec 6): rule-based, no model, run before saving AND every time a page is shown.
// The patterns are the specification (docs/specs/D2-about-pages.md sec 6.2, in this order: the first match names the rule).
// Tier meaning: 'ALL' = every page and candidate; 'DRAFT' = AI drafts only; 'DRAFT-OUTSIDE-LIFESPAN-CHARACTERISTICS' = AI drafts, in
// every section except `lifespan` and `characteristics`.
export type RuleTier = 'ALL' | 'DRAFT' | 'DRAFT-OUTSIDE-LIFESPAN-CHARACTERISTICS';
export interface GuardRule { id: string; tier: RuleTier; re: RegExp }
export const RULES: GuardRule[] = [
  { id: 'LINK', tier: 'ALL', re: /https?:\/\/|www\.|\]\(|<\s*a\s|\b[a-z0-9-]+\.(?:com|org|net|ie|uk|gov|edu)\b/i },
  { id: 'EMAIL', tier: 'ALL', re: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i },
  { id: 'PHONE', tier: 'ALL', re: /\+?\d(?:[\s().-]?\d){8,}/ },
  { id: 'DOSE_UNIT', tier: 'ALL', re: /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|μg|ml|iu|drops?|tablets?|capsules?|tsp|tbsp|teaspoons?|tablespoons?)\b/i },
  { id: 'DRUG_WORD', tier: 'ALL', re: /\b(?:ibuprofen|paracetamol|acetaminophen|aspirin|antibiotics?|steroids?|painkillers?|analgesics?|anti-?inflammator(?:y|ies)|sedatives?|antihistamines?|ivermectin|meloxicam|metacam|dose[sd]?|dosage|dosing|homeopath\w*|essential oils?|tea tree)\b/i },
  { id: 'REASSURE', tier: 'ALL', re: /\b(?:nothing to worry|no need to worry|don'?t worry|not a concern|not serious|perfectly normal|nothing serious|(?:is|are|will be|should be|probably|likely|usually) (?:probably |likely )?(?:fine|harmless|okay|ok)|nothing to be concerned)\b/i },
  { id: 'ADDRESS', tier: 'ALL', re: /\byou(?:r|rs|rself|rselves)?\b|\byou['’](?:ve|ll|d|re)\b/i },
  { id: 'IMPERATIVE_HEALTH', tier: 'ALL', re: /\b(?:give|apply|rub|dab|administer|medicate|inject|syringe|dose)\s+(?:it|him|her|them|some)\b|\b(?:apply|rub|dab|administer|medicate|inject|syringe)\s+(?:the|a|an)\b/i },
  { id: 'TREAT_WORD', tier: 'DRAFT', re: /\b(?:treatments?|treated|treating|cures?|cured|curing|medicat\w*|prescri\w*|supplement\w*|remed(?:y|ies)|vaccin\w*|diseases?|illness\w*|infections?|infected|parasit\w*)\b/i },
  { id: 'BREEDING_WORD', tier: 'DRAFT', re: /\b(?:breed(?:s|ing|ers?)?|mating|gestation|pregnan\w*|litters?|offspring)\b/i },
  { id: 'FREQUENCY', tier: 'DRAFT', re: /\b(?:once|twice|\w+ times)\s+(?:a|per|each|every)\s+(?:day|week|month|hour)\b|\bevery\s+\w+\s+(?:hours?|days?|weeks?)\b/i },
  { id: 'DIGIT', tier: 'DRAFT-OUTSIDE-LIFESPAN-CHARACTERISTICS', re: /\d/ },
];

/** What a reader of a page sees in place of a statement the guard refuses. */
export const WITHHELD_TEXT = 'This point was withheld because it read like advice. Ask your vet.';

export type GuardTier = 'RESEARCHED' | 'DRAFT' | 'CANDIDATE';

/** The id of the first rule that rejects this statement, or null. sectionKey matters only for the digit rule on AI drafts. */
export function guardStatement(text: string, tier: GuardTier, sectionKey = ''): string | null {
  for (const r of RULES) {
    if (r.tier === 'ALL') { /* every tier */ }
    else if (tier !== 'DRAFT') continue;
    else if (r.tier === 'DRAFT-OUTSIDE-LIFESPAN-CHARACTERISTICS' && (sectionKey === 'lifespan' || sectionKey === 'characteristics')) continue;
    if (r.re.test(text)) return r.id;
  }
  return null;
}

export interface ShownStatement { text: string; withheld: boolean }
export interface Source { title: string; publisher: string; url: string; checked_on: string }
export interface ShownSection { statements: ShownStatement[]; sources: Source[] }

/** Section keys in display order, with their headings (the "habitat" heading for wild species is chosen by the caller). */
export const SECTIONS: { key: string; heading: string }[] = [
  { key: 'summary', heading: 'What it is' },
  { key: 'characteristics', heading: 'Appearance and character' },
  { key: 'habits', heading: 'Habits and behaviour' },
  { key: 'diet', heading: 'What it eats' },
  { key: 'housing', heading: 'Where and how it lives' },
  { key: 'lifespan', heading: 'How long it lives' },
  { key: 'breeding', heading: 'Breeding basics' },
  { key: 'health', heading: 'Common health issues, and signs worth a call to the vet' },
  { key: 'care_notes', heading: 'Good to know' },
];
export const SECTION_KEYS: string[] = SECTIONS.map((s) => s.key);

/** Display-time defence in depth (sec 6.5): only well-formed sources with an https link are shown, whatever is stored. */
export function cleanSources(list: unknown[]): Source[] {
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  return list.filter((x): x is Source => {
    if (typeof x !== 'object' || x === null) return false;
    const s = x as Record<string, unknown>;
    return str(s.title) && str(s.publisher) && str(s.url) && /^https:\/\/\S+$/.test(s.url) && str(s.checked_on);
  }).map((s) => ({ title: s.title, publisher: s.publisher, url: s.url, checked_on: s.checked_on }));
}

/**
 * Display-time guard (sec 6.5): every stored statement is checked again; a refusing statement is replaced in place. A section whose
 * statements are all withheld still appears (heading plus the one withheld line). Keys outside the allowed list are not shown, and an
 * AI draft never shows breeding or health. The stored text is never changed.
 */
export function guardSections(sections: unknown, tier: 'RESEARCHED' | 'DRAFT'): Record<string, ShownSection> {
  const out: Record<string, ShownSection> = {};
  if (typeof sections !== 'object' || sections === null) return out;
  const src = sections as Record<string, unknown>;
  for (const key of SECTION_KEYS) {
    if (tier === 'DRAFT' && (key === 'breeding' || key === 'health')) continue;
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as { statements?: unknown }).statements) ? (raw as { statements: unknown[] }).statements : [];
    const statements = list.filter((t): t is string => typeof t === 'string').map((text) => {
      const hit = guardStatement(text, tier, key);
      return hit ? { text: WITHHELD_TEXT, withheld: true } : { text, withheld: false };
    });
    if (!statements.length) continue;
    const srcs = !Array.isArray(raw) && Array.isArray((raw as { sources?: unknown }).sources) ? cleanSources((raw as { sources: unknown[] }).sources) : [];
    out[key] = { statements, sources: srcs };
  }
  return out;
}


// D2 sec 6.2: every rule has its listed failing and passing sentences (generated from the spec's table; edit the spec first).
import { describe, expect, it } from 'vitest';
import { guardSections, guardStatement, RULES, WITHHELD_TEXT } from '../src/aboutguard.js';

const EXAMPLES: { id: string; tier: string; fail: string[]; pass: string[] }[] = [
  { id: 'LINK', tier: 'ALL', fail: ["See https://www.rspca.org.uk for more.","Visit birdwatchireland.ie to find out."], pass: ["Lives near rivers and ponds.","Lifespan is about 8 years."] },
  { id: 'EMAIL', tier: 'ALL', fail: ["Write to info@example.com about it.","Ask sue@vets.ie for details."], pass: ["Prefers quiet, shaded places.","Eats seeds and small insects."] },
  { id: 'PHONE', tier: 'ALL', fail: ["Ring 01 234 5678 straight away.","Call +353 1 234 5678."], pass: ["Weighs 1.5 to 2.5 kg when grown.","Usually lives 10 to 15 years."] },
  { id: 'DOSE_UNIT', tier: 'ALL', fail: ["Give 5 mg once a day.","Add 2 drops to the water."], pass: ["Grows to about 30 cm long.","Weighs up to 4 kg."] },
  { id: 'DRUG_WORD', tier: 'ALL', fail: ["A vet may prescribe antibiotics.","Never guess the dosage yourself."], pass: ["Needs a calcium-rich diet.","Eats insects, seeds and berries."] },
  { id: 'REASSURE', tier: 'ALL', fail: ["A limp is nothing to worry about.","It is probably fine if it sneezes."], pass: ["Males are usually larger than females.","A normal adult weight is around 2 kg."] },
  { id: 'ADDRESS', tier: 'ALL', fail: ["If your rabbit has stopped eating, ring the vet.","You should keep it warm."], pass: ["A rabbit that stops eating for a day needs a vet at once.","Signs include a fluffed-up, sleepy bird."] },
  { id: 'IMPERATIVE_HEALTH', tier: 'ALL', fail: ["Give it fresh water and rest.","Rub the sore area with cream."], pass: ["Needs fresh water every day.","Rubs its face on objects to mark territory.","Gives a loud alarm call when disturbed."] },
  { id: 'TREAT_WORD', tier: 'DRAFT', fail: ["A common illness is a chest infection.","Some kinds need a vaccination."], pass: ["Likes to sunbathe on warm rocks.","Often seen near hedges in winter."] },
  { id: 'BREEDING_WORD', tier: 'DRAFT', fail: ["It breeds in early spring.","A litter has four to six young."], pass: ["Lives in small family groups.","Active mostly at dusk and dawn."] },
  { id: 'FREQUENCY', tier: 'DRAFT', fail: ["Fed twice a day.","Eats three times a day."], pass: ["Active at dawn and dusk.","Feeds mostly at night."] },
  { id: 'DIGIT', tier: 'DRAFT-OUTSIDE-LIFESPAN-CHARACTERISTICS', fail: ["Eats 3 handfuls of greens.","Sleeps about 14 hours."], pass: ["Eats mostly leaves and shoots.","Sleeps for much of the day."] },
];

describe('About guard rules (sec 6.2)', () => {
  it('has exactly the rules the spec lists, in order', () => {
    expect(RULES.map((r) => r.id)).toEqual(EXAMPLES.map((e) => e.id));
    expect(RULES.map((r) => r.tier)).toEqual(EXAMPLES.map((e) => e.tier));
  });
  for (const e of EXAMPLES) {
    const rule = RULES.find((r) => r.id === e.id)!;
    it(`${e.id}: each failing sentence matches it, no passing sentence matches it`, () => {
      expect(e.fail.length).toBeGreaterThanOrEqual(2);
      expect(e.pass.length).toBeGreaterThanOrEqual(2);
      for (const s of e.fail) expect(rule.re.test(s), s).toBe(true);
      for (const s of e.pass) expect(rule.re.test(s), s).toBe(false);
    });
    it(`${e.id}: passing sentences pass the whole guard for the tiers that use the rule`, () => {
      for (const s of e.pass) {
        expect(guardStatement(s, 'RESEARCHED', 'habits'), s).toBeNull();
        expect(guardStatement(s, 'CANDIDATE'), s).toBeNull();
        // draft-only rules' passes must also pass every other draft rule; the digit rule's passes carry no digits
        if (e.tier !== 'ALL') expect(guardStatement(s, 'DRAFT', 'habits'), s).toBeNull();
      }
    });
  }
});

describe('which rules apply where (sec 6.3)', () => {
  it('draft-only words are allowed in researched pages and candidates, refused in drafts', () => {
    const s = 'A common illness is a chest infection.';
    expect(guardStatement(s, 'RESEARCHED', 'health')).toBeNull();
    expect(guardStatement(s, 'CANDIDATE')).toBeNull();
    expect(guardStatement(s, 'DRAFT', 'habits')).toBe('TREAT_WORD');
  });
  it('digits: fine in researched pages, and in a draft only in lifespan and characteristics', () => {
    const s = 'Usually lives about 8 years in a good home.';
    expect(guardStatement(s, 'RESEARCHED', 'lifespan')).toBeNull();
    expect(guardStatement(s, 'DRAFT', 'lifespan')).toBeNull();
    expect(guardStatement(s, 'DRAFT', 'characteristics')).toBeNull();
    expect(guardStatement(s, 'DRAFT', 'diet')).toBe('DIGIT');
  });
  it('the first matching rule names the failure', () => {
    expect(guardStatement('If your rabbit takes 5 mg, ring a vet.', 'RESEARCHED', 'health')).toBe('DOSE_UNIT');
  });
  it('realistic researched sentences pass', () => {
    for (const s of ['Lives for 8 to 12 years if well cared for.', 'A rabbit that has not eaten for 12 hours needs an urgent vet visit.', 'Hens lay up to 300 eggs a year.', 'Adults weigh 1.5 to 2.5 kg and measure about 40 cm.']) {
      expect(guardStatement(s, 'RESEARCHED', 'health'), s).toBeNull();
    }
  });
});

describe('display-time guard (sec 6.5)', () => {
  it('replaces a refused statement in place and keeps a section whose statements are all withheld', () => {
    const shown = guardSections({
      summary: { statements: ['A small, long-eared grazing animal.', 'Ring 01 234 5678 straight away.'], sources: [] },
      diet: { statements: ['You should give it fresh water and rest.'], sources: [] },
      junk: { statements: ['x'], sources: [] },
    }, 'RESEARCHED');
    expect(shown.summary!.statements).toEqual([{ text: 'A small, long-eared grazing animal.', withheld: false }, { text: WITHHELD_TEXT, withheld: true }]);
    expect(shown.diet!.statements).toEqual([{ text: WITHHELD_TEXT, withheld: true }]);
    expect(Object.keys(shown)).toEqual(['summary', 'diet']);
  });
  it('an AI draft never shows breeding or health, even if somehow stored', () => {
    const shown = guardSections({ summary: ['Lives in burrows in warm places.'], health: ['Gets ill sometimes in winter.'], breeding: ['Lays eggs in spring time.'] }, 'DRAFT');
    expect(Object.keys(shown)).toEqual(['summary']);
  });
});


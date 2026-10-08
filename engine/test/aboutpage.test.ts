// D2 sec 9.1 / 9.2: the rules a researched page file must meet before the loader will write it. Pure: no database.
import { describe, expect, it } from 'vitest';
import { cleanSources, guardSections } from '../src/aboutguard.js';
import { canonicalJson, contentHash, pageProblems, sourceCount, type PageFile } from '../src/aboutpage.js';

const TODAY = '2026-10-08';
const src = (n: number, publisher = `Publisher ${n}`, checked = '2026-10-01') => ({ title: `Source ${n}`, publisher, url: `https://example.org/${n}`, checked_on: checked });
const sec = (text: string, n = 1) => ({ statements: [text], sources: [src(n)] });
const two = (text: string) => ({ statements: [text], sources: [src(1, 'RSPB'), src(2, 'Vet College')] });

function wild(): PageFile {
  return {
    species: 'Robin', checked_on: '2026-10-05', written_by: 'a cold research session', reviewed_by: 'ryan',
    sections: {
      summary: sec('A small brown garden bird with an orange-red breast.'),
      characteristics: sec('Round body, thin legs, dark eyes and a short bill.'),
      habits: sec('Defends a territory all year, even through the winter.'),
      diet: sec('Eats insects, worms, seeds and berries.'),
      housing: sec('Lives in woods, hedges and gardens with some cover.'),
      lifespan: sec('Most live about two years; the oldest live much longer.'),
      breeding: two('Nests low in a hollow, bank or an old kettle.'),
    },
  };
}
function pet(): PageFile {
  const f = wild();
  f.species = 'Rabbit';
  f.sections.health = two('A rabbit that stops eating for a day needs a vet at once.');
  return f;
}
const ROBIN = { common_name: 'Robin', domain: 'WILD' };
const RABBIT = { common_name: 'Rabbit', domain: 'PET' };

describe('pageProblems', () => {
  it('accepts a complete wild page and a complete pet page', () => {
    expect(pageProblems(wild(), ROBIN, TODAY)).toEqual([]);
    expect(pageProblems(pet(), RABBIT, TODAY)).toEqual([]);
  });

  it('a pet page must have a health section, a wild page need not', () => {
    const f = pet();
    delete f.sections.health;
    expect(pageProblems(f, RABBIT, TODAY).join('\n')).toMatch(/health is required/);
    expect(pageProblems(wild(), ROBIN, TODAY)).toEqual([]);
  });

  it('every always-required section must be there', () => {
    for (const k of ['summary', 'characteristics', 'habits', 'diet', 'housing', 'lifespan', 'breeding']) {
      const f = wild();
      delete f.sections[k];
      expect(pageProblems(f, ROBIN, TODAY).join('\n'), k).toMatch(new RegExp(`section ${k} is required`));
    }
  });

  it('refuses unknown species, a wrong species name, and shape errors', () => {
    expect(pageProblems(wild(), null, TODAY)[0]).toMatch(/no species called "Robin"/);
    expect(pageProblems(wild(), { common_name: 'Blackbird', domain: 'WILD' }, TODAY).join('\n')).toMatch(/must equal "Blackbird"/);
    expect(pageProblems({ species: 'Robin' }, ROBIN, TODAY).length).toBeGreaterThan(0);
    const extra = { ...wild(), surprise: 1 };
    expect(pageProblems(extra, ROBIN, TODAY).length).toBeGreaterThan(0);
    const f = wild();
    f.sections.summary = { statements: ['one is fine here.', 'two is fine here.', 'three is fine here.', 'four is too many.'], sources: [src(1)] };
    expect(pageProblems(f, ROBIN, TODAY).length).toBeGreaterThan(0); // summary holds at most 3
  });

  it('statements are 10 to 240 characters and sources need an https link', () => {
    const f = wild();
    f.sections.diet = sec('Seeds.');
    expect(pageProblems(f, ROBIN, TODAY).length).toBeGreaterThan(0);
    const g = wild();
    g.sections.diet = sec('Eats seeds and berries. '.repeat(12));
    expect(pageProblems(g, ROBIN, TODAY).length).toBeGreaterThan(0);
    const h = wild();
    h.sections.diet!.sources = [{ ...src(1), url: 'http://example.org/1' }];
    expect(pageProblems(h, ROBIN, TODAY).length).toBeGreaterThan(0);
  });

  it('dates must be real and in order', () => {
    const f = wild();
    f.checked_on = '2026-02-30';
    expect(pageProblems(f, ROBIN, TODAY).join('\n')).toMatch(/checked_on must be a real date/);
    const g = wild();
    g.checked_on = '2026-10-09';
    expect(pageProblems(g, ROBIN, TODAY).join('\n')).toMatch(/not after today/);
    const h = wild();
    h.sections.diet!.sources = [src(1, 'RSPB', '2026-10-06')]; // after the page's own checked_on (10-05)
    expect(pageProblems(h, ROBIN, TODAY).join('\n')).toMatch(/diet source 1/);
  });

  it('breeding and health need two different publishers (case and spacing do not make a second one)', () => {
    const f = wild();
    f.sections.breeding = { statements: ['Nests low in a hollow, bank or an old kettle.'], sources: [src(1, 'RSPB'), src(2, ' rspb ')] };
    expect(pageProblems(f, ROBIN, TODAY).join('\n')).toMatch(/breeding needs sources from at least two different publishers/);
    const g = pet();
    g.sections.health = sec('A rabbit that stops eating for a day needs a vet at once.');
    expect(pageProblems(g, RABBIT, TODAY).join('\n')).toMatch(/health needs sources from at least two/);
  });

  it('runs the guard in its researched tier: a link, a drug word are refused; draft-only rules do not apply', () => {
    const f = wild();
    f.sections.diet = sec('See https://www.rspb.org.uk for the full list of foods.');
    expect(pageProblems(f, ROBIN, TODAY).join('\n')).toMatch(/diet statement 1 is refused by guard rule LINK/);
    const g = pet();
    g.sections.health = two('A vet may prescribe antibiotics for this problem.');
    expect(pageProblems(g, RABBIT, TODAY).join('\n')).toMatch(/guard rule DRUG_WORD/);
    const h = wild();
    h.sections.habits = sec('Sings loudly and breeds in early spring across 2 broods.');
    expect(pageProblems(h, ROBIN, TODAY)).toEqual([]);
  });

  it('refuses control characters and a quotation over 25 words', () => {
    const f = wild();
    f.sections.diet = sec('Eats seeds\u0007 and berries every day.');
    expect(pageProblems(f, ROBIN, TODAY).join('\n')).toMatch(/control character/);
    const g = wild();
    const long = Array.from({ length: 26 }, () => 'word').join(' ');
    g.sections.diet = sec(`The guide says "${long}" about the diet.`);
    expect(pageProblems(g, ROBIN, TODAY).join('\n')).toMatch(/quotes more than 25 words/);
    const h = wild();
    h.sections.diet = sec('The guide calls it "a tidy eater" in short.');
    expect(pageProblems(h, ROBIN, TODAY)).toEqual([]);
  });
});

describe('sourceCount, canonicalJson, contentHash', () => {
  it('counts distinct source links across sections', () => {
    const f = wild();
    expect(sourceCount(f.sections)).toBe(2); // every section cites example.org/1; breeding adds /2
    f.sections.diet = { statements: f.sections.diet!.statements, sources: [src(9), src(10)] };
    expect(sourceCount(f.sections)).toBe(4);
  });

  it('canonical JSON ignores key order and spacing', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('the hash is stable, ignores key order, and changes with any stored field', () => {
    const f = wild();
    const h = contentHash(f);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(JSON.parse(JSON.stringify(f)) as PageFile)).toBe(h);
    const reordered: PageFile = { sections: f.sections, reviewed_by: f.reviewed_by, written_by: f.written_by, checked_on: f.checked_on, species: f.species };
    expect(contentHash(reordered)).toBe(h);
    for (const change of [
      (x: PageFile) => { x.checked_on = '2026-10-06'; },
      (x: PageFile) => { x.written_by = 'someone else'; },
      (x: PageFile) => { delete x.reviewed_by; },
      (x: PageFile) => { x.sections.diet!.statements = ['Eats mostly insects and worms.']; },
    ]) {
      const g = JSON.parse(JSON.stringify(f)) as PageFile;
      change(g);
      expect(contentHash(g)).not.toBe(h);
    }
  });
});

describe('a malformed stored page never breaks the display', () => {
  it('sourceCount tolerates sections with no sources, sources that are not lists, and rubbish', () => {
    expect(sourceCount(null)).toBe(0);
    expect(sourceCount('x')).toBe(0);
    expect(sourceCount({ diet: { statements: ['x'] }, summary: 5, habits: { sources: 'no' }, housing: { sources: [null, { url: 3 }, { url: 'https://example.org/a' }] } })).toBe(1);
  });

  it('only well-formed https sources are shown', () => {
    const ok = { title: 'T', publisher: 'P', url: 'https://example.org/x', checked_on: '2026-10-01' };
    expect(cleanSources([ok, { ...ok, url: 'javascript:alert(1)' }, { ...ok, url: 'http://example.org' }, { ...ok, title: '' }, { ...ok, publisher: 3 }, null, 'x', { ...ok, url: 'https://a b' }])).toEqual([ok]);
  });

  it('guardSections shows what it can of a damaged row and drops the rest', () => {
    const shown = guardSections({
      summary: 5,
      diet: { statements: ['Eats insects, worms and seeds.', 7, null] },
      habits: { statements: ['Active at dusk.'], sources: [{ title: 'T', publisher: 'P', url: 'javascript:alert(1)', checked_on: '2026-10-01' }] },
      secret: { statements: ['Not a known section.'], sources: [] },
    }, 'RESEARCHED');
    expect(Object.keys(shown)).toEqual(['habits', 'diet']);
    expect(shown.diet!.statements).toEqual([{ text: 'Eats insects, worms and seeds.', withheld: false }]);
    expect(shown.diet!.sources).toEqual([]);
    expect(shown.habits!.sources).toEqual([]); // the javascript: link is not shown
  });
});

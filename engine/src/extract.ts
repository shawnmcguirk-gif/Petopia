// Text out of a document (Petopia D1 spec sec 5.2), copied from Vitalis engine/src/extract.ts: the text layer first,
// local glm-ocr (OLLAMA_URL, the Alienware over Tailscale) only for a page with (almost) no text. Images are read HERE,
// at home; only the resulting text ever reaches the AI reader, never the image (sec 5, Q4). The extractor is injectable
// so tests need neither Python nor Ollama. Env names: PETOPIA_PYTHON, PETOPIA_PAGES_SCRIPT, OCR_MODEL, OLLAMA_URL.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { docxText } from './docx.js';

const run = promisify(execFile);

export interface PageText {
  page: number;
  text: string;
}
export interface OcrIdentity {
  model_name: string;
  model_digest: string | null;
}
export interface Extractor {
  /** text layer per page (PDF) or the whole file as one page (md/txt); images return one empty page so OCR runs */
  textPages(abs: string): Promise<PageText[]>;
  /** OCR one page (PDF page number, or 1 for an image file) */
  ocrPage(abs: string, page: number): Promise<string>;
  ocrIdentity(): Promise<OcrIdentity>;
}

export const MIN_TEXT_CHARS = 40;
/** Files that are text, never images: their text is used as is and never sent to OCR (a .docx's bytes are a zip). */
export const TEXT_ONLY = ['.md', '.txt', '.docx'];
export const MAX_PAGES = 60; // review #12: page cap; later pages are left unread and the run says so

/** glm-ocr's answer is the page text, often followed by a ```markdown copy of it and then a run of bare fences until it hits its token limit
 *  (seen live in Epicure, 2026-10-03). If the answer opens with a fence the content is what sits between that fence and the next; otherwise it is
 *  everything before the first fence. Pure. */
export function stripFences(t: string): string {
  const lines = t.split('\n'); const isFence = (l: string) => /^\s*```/.test(l);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first >= 0 && isFence(lines[first]!)) { const end = lines.findIndex((l, i) => i > first && isFence(l)); return lines.slice(first + 1, end < 0 ? undefined : end).join('\n').trim(); }
  const end = lines.findIndex(isFence);
  return (end < 0 ? lines : lines.slice(0, end)).join('\n').trim();
}

/** Loopback, RFC 1918, Tailscale (100.64/10), *.local and bare hostnames only. Pure. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function ollamaUrl(): string | null {
  const u = process.env.OLLAMA_URL;
  if (!u) return null;
  const host = new URL(u).hostname;
  if (!isPrivateHost(host)) throw new Error(`OLLAMA_URL host ${host} is not a private address: OCR must stay on the home network`);
  return u.replace(/\/$/, '');
}

export function defaultExtractor(): Extractor {
  const py = process.env.PETOPIA_PYTHON ?? 'python3';
  const script = process.env.PETOPIA_PAGES_SCRIPT ?? new URL('../../extract/pages.py', import.meta.url).pathname;
  const model = process.env.OCR_MODEL ?? 'glm-ocr';
  const isPdf = (abs: string) => extname(abs).toLowerCase() === '.pdf';
  return {
    async textPages(abs) {
      const ext = extname(abs).toLowerCase();
      if (ext === '.md' || ext === '.txt') return [{ page: 1, text: await readFile(abs, 'utf8') }];
      if (ext === '.docx') return [{ page: 1, text: docxText(await readFile(abs)) }];
      if (!isPdf(abs)) return [{ page: 1, text: '' }];
      const { stdout } = await run(py, [script, 'text', abs], { maxBuffer: 50_000_000 });
      return JSON.parse(stdout) as PageText[];
    },
    async ocrPage(abs, page) {
      const base = ollamaUrl();
      if (!base) throw new Error('OLLAMA_URL is not set: OCR is not configured');
      const image = isPdf(abs) ? (await run(py, [script, 'png', abs, String(page)], { maxBuffer: 50_000_000 })).stdout.trim() : (await readFile(abs)).toString('base64');
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // at the default temperature glm-ocr reads the page and then loops until Ollama aborts with HTTP 500 "token repeat limit reached"; at 0 it ends in a run of fences and the stop cuts it (found in Epicure, 2026-10-03). No repeat penalty: it could distort repeated numbers and units in a record.
        body: JSON.stringify({ model, prompt: 'Text Recognition:', images: [image], stream: false, options: { temperature: 0, num_predict: 4096, stop: ['```\n```'] } }),
        signal: AbortSignal.timeout(180_000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`OCR host answered ${res.status}`);
      return stripFences(String(((await res.json()) as { response?: string }).response ?? ''));
    },
    async ocrIdentity() {
      const base = ollamaUrl();
      if (!base) return { model_name: model, model_digest: null };
      try {
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        const tags = (await res.json()) as { models?: { name: string; digest: string }[] };
        const hit = tags.models?.find((x) => x.name === model || x.name.startsWith(`${model}:`));
        return { model_name: hit?.name ?? model, model_digest: hit?.digest ?? null };
      } catch {
        return { model_name: model, model_digest: null };
      }
    },
  };
}

export interface ExtractionOutcome {
  method: 'TEXT_LAYER' | 'OCR';
  status: 'OK' | 'EMPTY' | 'FAILED';
  pages: PageText[];
  identity: OcrIdentity | null;
  error: string | null;
}

/** Text layer where a page has it, OCR where it does not (S5.2). A failed OCR page is an error on the run, not a crash. */
export async function extractDocument(ex: Extractor, abs: string): Promise<ExtractionOutcome> {
  let layer: PageText[];
  try {
    layer = await ex.textPages(abs);
  } catch (e) {
    return { method: 'TEXT_LAYER', status: 'FAILED', pages: [], identity: null, error: e instanceof Error ? e.message : String(e) };
  }
  const pages: PageText[] = [];
  let ocrUsed = false;
  let error: string | null = null;
  for (const p of layer) {
    if (p.page > MAX_PAGES) {
      error = `only the first ${MAX_PAGES} pages were read`;
      break;
    }
    if (p.text.trim().length >= MIN_TEXT_CHARS || TEXT_ONLY.includes(extname(abs).toLowerCase())) {
      pages.push(p);
      continue;
    }
    try {
      pages.push({ page: p.page, text: await ex.ocrPage(abs, p.page) });
      ocrUsed = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      pages.push(p);
    }
  }
  const any = pages.some((p) => p.text.trim().length > 0);
  return {
    method: ocrUsed ? 'OCR' : 'TEXT_LAYER',
    status: any ? 'OK' : error ? 'FAILED' : 'EMPTY',
    pages,
    identity: ocrUsed ? await ex.ocrIdentity() : null,
    error,
  };
}

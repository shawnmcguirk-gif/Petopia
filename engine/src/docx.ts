// Copied unchanged from Vitalis engine/src/docx.ts (Petopia D1 S5).
// .docx text (D1 spec S7.13; S5.9 limit 1): a Word file is a zip whose word/document.xml holds the text. Pure Node (zlib),
// no Python and no OCR: a .docx has no page images, and sending its bytes to OCR (what slice 2 did) reads nothing.
// Paragraphs become lines; a table row becomes one line with its cells separated by a tab (paragraphs inside a cell are
// joined with a space). A .docx has no fixed pages, so the whole document is page 1. Never writes anything.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 50_000_000;

/** One named entry of a zip archive (stored or deflated), or null when absent. Throws on a damaged archive. Pure. */
export function zipEntry(buf: Buffer, name: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('damaged zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (entryName !== name) continue;
    if (usize > MAX_ENTRY_BYTES) throw new Error('zip entry too large');
    if (buf.readUInt32LE(local) !== LOC_SIG) throw new Error('damaged zip local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new Error(`unsupported zip compression method ${method}`);
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

/** word/document.xml -> text: paragraphs as lines, table rows as tab-separated cells. Pure. */
export function documentXmlText(xml: string): string {
  const lines: string[] = [];
  let para = '';
  let inText = false;
  let cellDepth = 0;
  let cellParas: string[] = [];
  let cells: string[] = [];
  const endPara = () => {
    if (cellDepth > 0) cellParas.push(para);
    else lines.push(para);
    para = '';
  };
  for (const m of xml.matchAll(/<(\/?)([A-Za-z0-9]+:[A-Za-z0-9]+)\b[^>]*?(\/?)>|([^<]+)/g)) {
    const [, close, tag, self, text] = m;
    if (text !== undefined) {
      if (inText) para += decode(text);
      continue;
    }
    if (tag === 'w:t') inText = !close && !self;
    else if (tag === 'w:tab' && !close) para += '\t';
    else if ((tag === 'w:br' || tag === 'w:cr') && !close) para += '\n';
    else if (tag === 'w:p' && (close || self)) endPara();
    else if (tag === 'w:tc') {
      if (!close && !self) {
        cellDepth++;
        if (cellDepth === 1) cellParas = [];
      } else if (close) {
        cellDepth = Math.max(0, cellDepth - 1);
        if (cellDepth === 0) cells.push(cellParas.filter((x) => x.trim() !== '').join(' '));
      }
    } else if (tag === 'w:tr' && close && cellDepth === 0) {
      lines.push(cells.join('\t'));
      cells = [];
    }
  }
  if (para) lines.push(para);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The text of a .docx file's bytes. Throws when the bytes are not a Word document. Pure. */
export function docxText(buf: Buffer): string {
  const xml = zipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('not a Word document (no word/document.xml)');
  return documentXmlText(xml.toString('utf8'));
}

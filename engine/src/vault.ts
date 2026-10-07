// The vault boundary (spec sec 2 "Documents", 4.4, 5.1), copied from Vitalis engine/src/vault.ts with Petopia's folders:
// a person's pet documents arrive in <Name>/Pets/inbox/ and are filed to <Name>/Pets/filed/<kind>/ -- moved in place,
// never copied, never overwritten, never deleted. Every path is resolved inside VAULT_ROOT: no "..", no absolute path,
// no symlink that leaves the root. The database stores the vault-relative path and the SHA-256, never the bytes.
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, link, lstat, mkdir, readdir, realpath, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { bad, conflict } from './errors.js';

export const INBOX_SUB = 'Pets/inbox';
export const FILED_SUB = 'Pets/filed';

export const SCAN_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.md', '.txt', '.docx'];
export const UNSUPPORTED_EXTENSIONS = ['.doc', '.heic'];
const MEDIA: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.md': 'text/markdown', '.txt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.heic': 'image/heic',
};
export const mediaType = (name: string): string => MEDIA[extname(name).toLowerCase()] ?? 'application/octet-stream';
export const isImage = (name: string): boolean => ['.png', '.jpg', '.jpeg'].includes(extname(name).toLowerCase());

/** Absolute path for a vault-relative one, or 400. Pure lexical check first, then the deepest existing ancestor's real path. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (!rel || isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').includes('..')) throw bad('path must be relative to the vault and stay inside it');
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) throw bad('path escapes the vault');
  const realRoot = await realpath(root);
  let probe = full;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw bad('path escapes the vault through a link');
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  return full;
}

export async function fileExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export function sha256File(abs: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(abs).on('data', (d) => h.update(d)).on('error', fail).on('end', () => ok(h.digest('hex')));
  });
}

/** Vault-relative paths of the files directly or deeper under <folder>/Pets/inbox, skipping dotfiles and links. */
export async function listInbox(root: string, folder: string): Promise<string[]> {
  const baseRel = `${folder}/${INBOX_SUB}`;
  const base = await resolveInside(root, baseRel);
  const out: string[] = [];
  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dirAbs, e.name);
      const rel = `${dirRel}/${e.name}`;
      const st = await lstat(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(abs, rel);
      else if (st.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (SCAN_EXTENSIONS.includes(ext) || UNSUPPORTED_EXTENSIONS.includes(ext)) out.push(rel);
      }
    }
  }
  await walk(base, baseRel);
  return out.sort();
}

/**
 * Moves a file inside the vault. Never overwrites; refuses to cross volumes. (Vitalis safeMove.)
 * A hard link is the move (it fails if the destination exists, atomically). Where links are not allowed the fallback is
 * NOT rename(2), which silently replaces a destination that appeared after the check: it is an exclusive copy
 * (COPYFILE_EXCL: fails if the destination exists), checked byte for byte by SHA-256, and only then is the inbox entry
 * removed -- so a file already filed there is never overwritten (independent review, finding 9).
 */
export async function safeMove(root: string, fromRel: string, toRel: string): Promise<void> {
  const from = await resolveInside(root, fromRel);
  const to = await resolveInside(root, toRel);
  if (await fileExists(to)) throw conflict('a file with that name is already filed there');
  await mkdir(dirname(to), { recursive: true });
  try {
    await link(from, to);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'EEXIST') throw conflict('a file with that name is already filed there');
    if (code === 'EXDEV') throw conflict('source and destination are on different volumes');
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EMLINK') {
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL);
      } catch (e2) {
        if ((e2 as { code?: string }).code === 'EEXIST') throw conflict('a file with that name is already filed there');
        throw e2;
      }
      if ((await sha256File(from)) !== (await sha256File(to))) {
        await unlink(to); // our own incomplete copy, never someone's file (the exclusive copy created it)
        throw new Error('MOVE_COPY_MISMATCH');
      }
      const st = await stat(from);
      await utimes(to, st.atime, st.mtime).catch(() => undefined);
      await unlink(from);
      return;
    }
    throw e;
  }
  await unlink(from);
}

/** Where a filed document goes: <Name>/Pets/filed/<kind>/<file name>. Pure. */
export const filedPath = (folder: string, kind: string, fileName: string): string => `${folder}/${FILED_SUB}/${kind.toLowerCase()}/${fileName}`;

/** A file name that is safe to write into the inbox: no path parts, no dot-start, a known extension. Pure. */
export function safeFileName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop()!.normalize('NFC').replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/\s+/g, ' ').trim().slice(-120);
  if (!base || base.startsWith('.') || !SCAN_EXTENSIONS.includes(extname(base).toLowerCase())) return null;
  return base;
}

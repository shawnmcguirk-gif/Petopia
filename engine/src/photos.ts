// Animal photos (spec sec 2 "Photos", 7.3, A8), copied from Epicure engine/src/photos.ts.
// Every upload is DECODED and RE-ENCODED here, never stored as sent: orientation applied, longest side at most 1600 px,
// JPEG, and NO metadata at all -- no EXIF (so no GPS, no device ids, no timestamps), no XMP, no IPTC, no ICC profile
// (pixels are converted to sRGB first). A photo therefore cannot leak where it was taken (sec 7.3). The file is named
// by the SHA-256 of the processed bytes and lives in <vault>/_petopia-media/, not in any member's folder; the same photo
// uploaded twice is one file. Unlike Epicure, media is only ever served to a signed-in household member (server.ts).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import { PetopiaError } from './errors.js';

export const MEDIA_DIR = '_petopia-media';
export const MAX_SIDE = 1600;
export const MAX_IN = 12_000_000;
export const MEDIA_NAME = /^([0-9a-f]{64})\.jpg$/;

export interface Processed {
  jpeg: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Decode and re-encode. Throws a plain 400/413 for anything that is not a photo this server can open. */
export async function processPhoto(input: Buffer, side = MAX_SIDE): Promise<Processed> {
  if (input.length > MAX_IN) throw new PetopiaError(413, 'that photo is too big (12 MB at most)');
  if (input.length < 16) throw new PetopiaError(400, 'that is not a photo I can use');
  let out: { data: Buffer; info: OutputInfo };
  try {
    const img = sharp(input, { limitInputPixels: 60_000_000, failOn: 'error' });
    const meta = await img.metadata();
    if (!['jpeg', 'png', 'webp', 'heif'].includes(meta.format ?? '')) throw new Error('format');
    out = await img
      .rotate() // apply EXIF orientation to the pixels, before the EXIF is dropped
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 84, mozjpeg: true }) // no .withMetadata()/.keepMetadata(): nothing carries over
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new PetopiaError(400, 'that is not a photo I can use (JPEG, PNG or WebP)');
  }
  return { jpeg: out.data, width: out.info.width, height: out.info.height, sha256: sha256(out.data) };
}

export const vaultRoot = (): string => {
  const v = process.env.VAULT_ROOT;
  if (!v) throw new PetopiaError(503, 'photo storage is not set up on this server (VAULT_ROOT)');
  return v;
};
const mediaDir = (root: string) => join(root, MEDIA_DIR);

/** Writes atomically (temp file + rename). Returns the vault-relative path stored in media.item. */
export async function storePhoto(root: string, p: Processed): Promise<string> {
  const dir = mediaDir(root);
  await mkdir(dir, { recursive: true });
  const dest = join(dir, `${p.sha256}.jpg`);
  const tmp = join(dir, `.${p.sha256}.${process.pid}.tmp`);
  await writeFile(tmp, p.jpeg, { flag: 'w', mode: 0o600 });
  await rename(tmp, dest);
  return `${MEDIA_DIR}/${p.sha256}.jpg`;
}

/** Only a 64-hex name is ever read, so no path can be smuggled in. */
export async function readMedia(root: string, name: string): Promise<Buffer | null> {
  const m = MEDIA_NAME.exec(name);
  if (!m) return null;
  try {
    return await readFile(join(mediaDir(root), `${m[1]}.jpg`));
  } catch {
    return null;
  }
}

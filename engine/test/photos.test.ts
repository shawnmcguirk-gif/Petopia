// Photo pipeline (spec sec 2 "Photos", 7.3, A8): re-encode, max 1600 px, ALL metadata stripped incl. GPS, SHA-256 name.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { MEDIA_DIR, processPhoto, readMedia, sha256, storePhoto } from '../src/photos.js';

async function photoWithGps(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 150, b: 90 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Biscuit-Phone', Copyright: 'fixture' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '53/1 20/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '6/1 15/1 0/1' },
    })
    .toBuffer();
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('processPhoto', () => {
  it('the fixture really carries GPS before processing (so the next test means something)', async () => {
    const meta = await sharp(await photoWithGps(400, 300)).metadata();
    expect(meta.exif).toBeDefined();
    expect(meta.exif!.toString('latin1')).toContain('Biscuit-Phone');
  });

  it('strips every kind of metadata: no EXIF (so no GPS), no XMP, no IPTC, no ICC', async () => {
    const input = await photoWithGps(400, 300);
    const p = await processPhoto(input);
    const meta = await sharp(p.jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    const raw = p.jpeg.toString('latin1');
    expect(raw).not.toContain('Biscuit-Phone');
    expect(raw).not.toContain('Exif');
  });

  it('keeps the longest side at most 1600 px, keeps the aspect, never enlarges', async () => {
    const big = await processPhoto(await photoWithGps(4000, 3000));
    expect([big.width, big.height]).toEqual([1600, 1200]);
    const tall = await processPhoto(await photoWithGps(1000, 3200));
    expect([tall.width, tall.height]).toEqual([500, 1600]);
    const small = await processPhoto(await photoWithGps(320, 240));
    expect([small.width, small.height]).toEqual([320, 240]);
  });

  it('names the result by the SHA-256 of the processed bytes; the same photo twice is one name', async () => {
    const input = await photoWithGps(500, 500);
    const a = await processPhoto(input);
    const b = await processPhoto(input);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(sha256(a.jpeg));
    expect(b.sha256).toBe(a.sha256);
  });

  it('accepts PNG and WebP, refuses anything that is not a photo', async () => {
    const png = await sharp({ create: { width: 50, height: 50, channels: 4, background: '#33669980' } }).png().toBuffer();
    expect((await sharp((await processPhoto(png)).jpeg).metadata()).format).toBe('jpeg');
    const webp = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#aa0000' } }).webp().toBuffer();
    expect((await processPhoto(webp)).width).toBe(60);
    await expect(processPhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.repeat(5)))).rejects.toMatchObject({ status: 400 });
    await expect(processPhoto(Buffer.alloc(10))).rejects.toMatchObject({ status: 400 });
    await expect(processPhoto(Buffer.alloc(12_000_001))).rejects.toMatchObject({ status: 413 });
  });
});

describe('storePhoto / readMedia', () => {
  it('writes <root>/_petopia-media/<sha>.jpg atomically and reads back only 64-hex names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'petopia-photo-'));
    dirs.push(root);
    const p = await processPhoto(await photoWithGps(300, 200));
    const rel = await storePhoto(root, p);
    expect(rel).toBe(`${MEDIA_DIR}/${p.sha256}.jpg`);
    expect(await readdir(join(root, MEDIA_DIR))).toEqual([`${p.sha256}.jpg`]); // no temp file left behind
    expect((await readMedia(root, `${p.sha256}.jpg`))?.equals(p.jpeg)).toBe(true);
    expect(await readMedia(root, '../../etc/passwd')).toBeNull();
    expect(await readMedia(root, `${'0'.repeat(64)}.jpg`)).toBeNull();
  });
});

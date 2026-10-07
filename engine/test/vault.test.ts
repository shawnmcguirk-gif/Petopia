// The vault move where hard links are not allowed (finding 9): the old fallback was rename(2), which silently replaces a
// file that appears at the destination after the existence check. Now an exclusive copy: it never overwrites.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ beforeFallback: null as null | ((to: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    // a volume that does not allow hard links; optionally, someone else writes the destination at that very moment
    link: async (_from: string, to: string) => {
      await hooks.beforeFallback?.(to);
      throw Object.assign(new Error('links not allowed'), { code: 'EPERM' });
    },
  };
});
const { safeMove } = await import('../src/vault.js');

describe('safeMove without hard links (finding 9)', () => {
  let root = '';
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'petopia-vault-')); await mkdir(join(root, 'A/Pets/inbox'), { recursive: true }); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('moves the file, bytes unchanged, and removes the inbox entry', async () => {
    await writeFile(join(root, 'A/Pets/inbox/a.txt'), 'the original');
    await safeMove(root, 'A/Pets/inbox/a.txt', 'A/Pets/filed/other/a.txt');
    expect(await readFile(join(root, 'A/Pets/filed/other/a.txt'), 'utf8')).toBe('the original');
    expect(await readdir(join(root, 'A/Pets/inbox'))).not.toContain('a.txt');
  });

  it('a destination that appears after the check is never overwritten: 409, both files intact', async () => {
    await writeFile(join(root, 'A/Pets/inbox/b.txt'), 'the original');
    hooks.beforeFallback = (to) => writeFile(to, 'filed by someone else');
    try {
      await expect(safeMove(root, 'A/Pets/inbox/b.txt', 'A/Pets/filed/other/b.txt')).rejects.toMatchObject({ status: 409 });
    } finally {
      hooks.beforeFallback = null;
    }
    expect(await readFile(join(root, 'A/Pets/filed/other/b.txt'), 'utf8')).toBe('filed by someone else');
    expect(await readFile(join(root, 'A/Pets/inbox/b.txt'), 'utf8')).toBe('the original');
  });
});

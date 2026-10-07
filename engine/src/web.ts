// Static assets for the web UI (web/dist), copied from Vitalis engine/src/web.ts. Caddy strips /petopia/ before a request
// arrives, so the app is served at / here and uses only relative paths. Unknown client routes (no extension) get
// index.html; unknown files 404. Refuses traversal and dotfiles.
import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

export const webDist = (): string => resolve(process.env.WEB_DIST ?? join(process.cwd(), '..', 'web', 'dist'));

export async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (p.includes('\0') || p.includes('\\') || p.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return false;
  const root = webDist();
  const full = resolve(root, '.' + (p.endsWith('/') ? p + 'index.html' : p));
  if (full !== root && !full.startsWith(root + sep)) return false;
  let target = full;
  try {
    if (!(await stat(target)).isFile()) throw new Error('not a file');
  } catch {
    if (extname(p)) return false;
    target = join(root, 'index.html');
  }
  try {
    const body = await readFile(target);
    const html = target.endsWith('.html');
    const hashed = /\/assets\//.test(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': html ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

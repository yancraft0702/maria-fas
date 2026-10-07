import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const outputRoot = path.join(root, '.vercel', 'output');
const staticRoot = path.join(outputRoot, 'static');

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(staticRoot, { recursive: true });
await fs.cp(webRoot, staticRoot, { recursive: true });
await fs.writeFile(
  path.join(outputRoot, 'config.json'),
  `${JSON.stringify({
    version: 3,
    routes: [
      { handle: 'filesystem' },
      { src: '^/(?!api(?:/|$)|ws(?:/|$)).*$', dest: '/index.html' },
    ],
  }, null, 2)}\n`,
);

console.log(`Vercel static output generated from ${path.relative(root, webRoot)}`);

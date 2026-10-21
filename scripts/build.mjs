import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { adapters } from '../src/adapters/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildUserscript({ output = resolve(root, 'dist/toolpatch.user.js'), updateBase } = {}) {
  const { version, config } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (updateBase === undefined) updateBase = config?.updateBase;
  let updateURL;
  if (updateBase != null) {
    let base;
    try { base = new URL(updateBase); } catch { throw new Error('Update base must be an absolute HTTPS URL.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
      throw new Error('Update base must be an HTTPS directory URL ending in /, without credentials, query or hash.');
    }
    updateURL = new URL('toolpatch.user.js', base).href;
  }
  const metadata = [
    '// ==UserScript==',
    '// @name         Toolpatch',
    '// @namespace    https://github.com/ronaldojf/toolpatch',
    `// @version      ${version}`,
    '// @description  WebMCP tools for supported sites, starting with Ursa temporary email.',
    `// @icon         https://raw.githubusercontent.com/ronaldojf/toolpatch/main/assets/icon.png?v=${version}`,
    ...[...new Set(adapters.flatMap(adapter => adapter.matches))].map(match => `// @match        ${match}`),
    ...(updateURL ? [`// @updateURL    ${updateURL}`, `// @downloadURL  ${updateURL}`] : []),
    '// @grant        none',
    '// @sandbox      raw',
    '// @run-at       document-end',
    '// @noframes',
    '// ==/UserScript==',
  ].join('\n');
  await build({ entryPoints: [resolve(root, 'src/main.js')], bundle: true, minify: true, format: 'iife', target: 'chrome131', outfile: output, banner: { js: metadata }, legalComments: 'none', charset: 'utf8' });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== '--update-base' || args.length !== 2)) {
    console.error('Usage: npm run build -- [--update-base https://host/path/]');
    process.exitCode = 1;
  } else {
    try { await buildUserscript({ updateBase: args[1] }); console.log('Built dist/toolpatch.user.js'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

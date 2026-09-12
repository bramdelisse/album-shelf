// Copy the labels out of the vault and into the repo, so the build has them.
//
//   ALBUM_LABELS set, file exists  -> read the vault, rewrite src/data/labels.json
//   ALBUM_LABELS not set           -> keep the committed copy (this is Cloudflare)
//   ALBUM_LABELS set, file missing -> fail loudly, stop the build
//
// Runs automatically before `dev` and `build`.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseTable, rowsToLabels } from './label-table.mjs';

const OUT = new URL('../src/data/labels.json', import.meta.url);

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const labelPath = process.env.ALBUM_LABELS;

if (!labelPath) {
  console.log('sync: ALBUM_LABELS not set — building from the committed labels.');
  process.exit(0);
}

if (!existsSync(labelPath)) {
  console.error(
    `sync: ALBUM_LABELS points at a file that does not exist:\n  ${labelPath}\n\n` +
      'Fix the path in .env, or unset it to build from the committed copy.',
  );
  process.exit(1);
}

const { labels, rejected } = rowsToLabels(parseTable(await readFile(labelPath, 'utf8')));

await writeFile(OUT, JSON.stringify(labels, null, 2) + '\n');

console.log(`sync: ${Object.keys(labels).length} labelled albums from the vault.`);
if (rejected.length) {
  console.log(`sync: ${rejected.length} row(s) skipped —`);
  for (const line of rejected) console.log(`  ${line}`);
}

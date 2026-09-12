// Read the dominant colour off every album cover and store it in the catalogue,
// so the labelling page can offer it as the starting point.
//
//     npm run colours
//
// Only downloads covers it has not read yet, so running it again is nearly free.
// Touches no labels — this writes data/albums.json, never the vault.

import { readFile, writeFile } from 'node:fs/promises';
import { fillCoverColours, needsColour } from './cover-colour.mjs';

const CATALOGUE = new URL('../data/albums.json', import.meta.url);

const force = process.argv.includes('--force');

const albums = JSON.parse(await readFile(CATALOGUE, 'utf8'));
if (force) for (const a of albums) delete a.colourAlgo;

const withCover = albums.filter((a) => a.cover);
const missing = withCover.filter(needsColour);

if (withCover.length === 0) {
  console.log('No covers in data/albums.json yet. Run npm run import first.');
  process.exit(0);
}

if (missing.length === 0) {
  console.log(`All ${withCover.length} covers have already been read.`);
  console.log('Use `npm run colours -- --force` to read them all again.');
  process.exit(0);
}

console.log(`Reading colours off ${missing.length} covers…`);

const done = await fillCoverColours(albums, {
  onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
});
process.stdout.write('\n');

await writeFile(CATALOGUE, JSON.stringify(albums, null, 2) + '\n');

const withColour = albums.filter((a) => a.coverColour).length;
console.log(`Done. ${withColour} of ${albums.length} albums have a suggested colour.`);
if (done < missing.length) {
  console.log(`${missing.length - done} could not be read — those fall back to your last colour.`);
}

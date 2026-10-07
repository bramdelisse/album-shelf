// Give every album a broad genre, read off its artists' genres in Spotify.
//
//     npm run genres
//
// Two steps. First it asks Spotify for the genres of every album it has not
// asked about before, and caches them in data/albums.json — so running it again
// is nearly free. Then it writes a broad genre into the `genre` column of the
// label table in the vault, for every album whose cell is still empty. A genre
// you typed there yourself is never overwritten.
//
//     npm run genres -- --remap    rewrite every genre cell from the cache, hand edits included
//     npm run genres -- --force    ask Spotify about every album again, then --remap

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getAccessToken } from './spotify-auth.mjs';
import { GENRES, OTHER, albumGenre, fillGenres, needsGenres } from './genre.mjs';
import { parseTable, renderTable, replaceBlock, rowsToLabels } from './label-table.mjs';

const CATALOGUE = new URL('../data/albums.json', import.meta.url);
const LABELS_OUT = new URL('../src/data/labels.json', import.meta.url);

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const force = process.argv.includes('--force');
const remap = force || process.argv.includes('--remap');
const labelPath = process.env.ALBUM_LABELS;

if (!labelPath || !existsSync(labelPath)) {
  console.error(
    labelPath
      ? `ALBUM_LABELS points at a file that does not exist:\n  ${labelPath}`
      : 'ALBUM_LABELS is not set. Put the path to albums.md in .env.',
  );
  process.exit(1);
}

console.log(`Genres go into ${labelPath} — close it in Obsidian first, so the two do not fight over the file.`);

// ---- 1. Spotify genres into the cache ----

const albums = JSON.parse(await readFile(CATALOGUE, 'utf8'));
if (force) for (const a of albums) delete a.spotifyGenres;

const missing = albums.filter(needsGenres).length;
let fetchError = null;

if (missing && !(remap && !force)) {
  try {
    console.log('Signing in to Spotify…');
    const token = await getAccessToken(process.env.SPOTIFY_CLIENT_ID);
    console.log(`Fetching genres for ${missing} albums…`);
    await fillGenres(albums, token, {
      onProgress: (n, total) => process.stdout.write(`\r  artist ${n}/${total}`),
    });
    process.stdout.write('\n');
  } catch (err) {
    fetchError = err;
  }
  // Written even after an error, so whatever was fetched is not asked for again.
  await writeFile(CATALOGUE, JSON.stringify(albums, null, 2) + '\n');
}

// ---- 2. Broad genres into the label table ----

const spotifyOf = new Map(albums.filter((a) => !needsGenres(a)).map((a) => [a.id, a.spotifyGenres]));

const text = await readFile(labelPath, 'utf8');
const rows = parseTable(text);
let filled = 0;
let kept = 0;

for (const row of rows) {
  if (!spotifyOf.has(row.id)) continue;
  const genre = albumGenre(spotifyOf.get(row.id));
  const current = (row.genre ?? '').trim();
  if (!current || remap) {
    if (current !== genre) filled++;
    row.genre = genre;
  } else if (current !== genre) {
    kept++;
  }
}

await writeFile(labelPath, replaceBlock(text, renderTable(rows)));
// Same as the labelling page: keep a running `npm run dev` current.
await writeFile(LABELS_OUT, JSON.stringify(rowsToLabels(rows).labels, null, 2) + '\n');

// ---- report ----

const counts = new Map([...GENRES.map((g) => [g.name, 0]), [OTHER, 0]]);
let other = 0;
for (const r of rows) {
  const g = (r.genre ?? '').trim();
  if (!g) continue;
  if (counts.has(g)) counts.set(g, counts.get(g) + 1);
  else other++;
}
const width = Math.max(...[...counts.keys()].map((k) => k.length));
console.log(`\nWrote ${filled} genre${filled === 1 ? '' : 's'} into ${labelPath}`);
if (kept) console.log(`Kept ${kept} genre${kept === 1 ? '' : 's'} you set by hand (use -- --remap to overwrite them).`);
console.log(`\n${rows.filter((r) => (r.genre ?? '').trim()).length} of ${rows.length} albums have a genre:`);
for (const [name, n] of counts) console.log(`  ${name.padEnd(width)}  ${n}`);
if (other) console.log(`  ${'(eigen)'.padEnd(width)}  ${other}`);

const left = rows.filter((r) => !spotifyOf.has(r.id)).length;
if (fetchError) {
  console.error(`\nSpotify stopped answering: ${fetchError.message}`);
  console.error('Run npm run genres again to fetch the rest.');
  process.exit(1);
}
if (left) console.log(`\n${left} albums have no Spotify genres yet — run npm run genres${remap && !force ? ' without --remap' : ' again after the next import'}.`);

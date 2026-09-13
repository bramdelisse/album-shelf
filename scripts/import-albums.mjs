// One command: pull the saved albums from Spotify, refresh the catalogue,
// and add any new albums to the label table in the vault as blank rows.
//
//     npm run import
//
// It never overwrites a label you typed. That is the whole contract.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getAccessToken } from './spotify-auth.mjs';
import { fillCoverColours, needsColour } from './cover-colour.mjs';
import {
  COLUMNS,
  GONE_END,
  GONE_START,
  SKIP_END,
  SKIP_START,
  ensureBlock,
  parseTable,
  renderTable,
  replaceBlock,
} from './label-table.mjs';

const SKIP_HEADING =
  '## Niet labelen\n\n' +
  '*Albums die ik bewust niet label. Verwijder de regel om er alsnog naar te kijken.*\n\n';

const CATALOGUE = new URL('../data/albums.json', import.meta.url);

const LABEL_TEMPLATE = `# Albums

*De labels van mijn albumplank. Deze tabel is de bron; de site leest hem.*

Drie assen, alle drie met de hand:

- **energy** — 0 (laag) tot 100 (hoog).
- **attention** — 0 (achtergrond) tot 100 (eist alle aandacht).
- **colour** — een hex, bijvoorbeeld \`#c24b3a\`. Op gevoel; er is geen palet.

Een album zonder alle drie de labels staat niet op de plank. \`gem\` is een \`x\` voor
mijn parels — dat zie je niet in het overzicht, alleen als je het album opent.
\`review\` is één zin die onder het album komt te staan; mag leeg blijven.
\`labelled\` is de datum waarop ik het label voor het laatst zette. \`artist\`, \`album\`,
\`year\` en \`id\` worden door \`npm run import\` geschreven — die hoef je niet aan te raken.

<!-- albums:start -->
<!-- albums:end -->

## Niet meer in mijn bibliotheek

*Albums die ik ge-unsaved heb. De labels blijven staan, voor als ze terugkomen.*

${GONE_START}
${GONE_END}

${SKIP_HEADING}${SKIP_START}
${SKIP_END}

> [!note]- Page description
> Deze tabel wordt bijgewerkt door \`npm run import\` in \`C:\\Dev\\album-shelf\\\`.
> Het script vervangt alleen wat tussen de \`<!-- albums:start -->\` en
> \`<!-- albums:end -->\` regels staat, dus alles wat je hieromheen schrijft blijft staan.
> **Verwijder die twee regels niet.**
>
> Albums die niet meer in je Spotify-bibliotheek zitten verhuizen naar het tweede
> blok in plaats van weg te vallen — anders zou je labels kwijtraken door een
> album per ongeluk te unsaven.
`;

function loadEnv() {
  const envFile = new URL('../.env', import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

async function fetchSavedAlbums(token) {
  const albums = [];
  let url = 'https://api.spotify.com/v1/me/albums?limit=50';

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 2);
      console.log(`  rate limited, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `Spotify returned ${res.status} for ${url}\n` +
          (res.status === 403
            ? 'A 403 here usually means the app is in development mode and this ' +
              'account is not on its user list, or the app has no Premium account behind it.'
            : ''),
      );
    }

    const page = await res.json();
    for (const item of page.items) {
      const a = item.album;
      albums.push({
        id: a.id,
        artist: a.artists.map((x) => x.name).join(', '),
        album: a.name,
        year: (a.release_date ?? '').slice(0, 4),
        cover: a.images?.sort((x, y) => x.width - y.width).find((i) => i.width >= 300)?.url
          ?? a.images?.[0]?.url
          ?? '',
        url: a.external_urls?.spotify ?? '',
        added: (item.added_at ?? '').slice(0, 10),
      });
    }
    process.stdout.write(`\r  fetched ${albums.length}`);
    url = page.next;
  }
  process.stdout.write('\n');
  return albums;
}

const byArtistThenYear = (a, b) =>
  a.artist.localeCompare(b.artist, 'nl') || String(a.year).localeCompare(String(b.year));

async function main() {
  loadEnv();

  const labelPath = process.env.ALBUM_LABELS;
  if (!labelPath) {
    throw new Error(
      'ALBUM_LABELS is not set, so there is nowhere to write the new albums.\n' +
        'Copy .env.example to .env and point it at albums.md in the vault.',
    );
  }

  console.log('Signing in to Spotify…');
  const token = await getAccessToken(process.env.SPOTIFY_CLIENT_ID);

  console.log('Fetching saved albums…');
  const spotifyAlbums = await fetchSavedAlbums(token);
  spotifyAlbums.sort(byArtistThenYear);

  // Carry over colours already read from covers, so we only download new ones.
  if (existsSync(CATALOGUE)) {
    const previous = JSON.parse(await readFile(CATALOGUE, 'utf8'));
    const known = new Map(previous.map((a) => [a.id, a]));
    for (const a of spotifyAlbums) {
      const old = known.get(a.id);
      if (old?.coverColour) {
        a.coverColour = old.coverColour;
        a.coverSource = old.coverSource;
        a.colourAlgo = old.colourAlgo;
      }
    }
  }

  const toRead = spotifyAlbums.filter((a) => a.cover && needsColour(a)).length;
  if (toRead) {
    console.log(`Reading colours off ${toRead} covers…`);
    await fillCoverColours(spotifyAlbums, {
      onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
    });
    process.stdout.write('\n');
  }

  await writeFile(CATALOGUE, JSON.stringify(spotifyAlbums, null, 2) + '\n');
  console.log(`Wrote data/albums.json — ${spotifyAlbums.length} albums.`);

  // --- merge into the label table, preserving every label already typed ---

  const exists = existsSync(labelPath);
  let original = exists ? await readFile(labelPath, 'utf8') : LABEL_TEMPLATE;
  if (!exists) console.log(`${labelPath} did not exist yet — creating it.`);
  original = ensureBlock(original, SKIP_START, SKIP_END, SKIP_HEADING);

  const existingRows = parseTable(original);
  const goneRows = parseTable(original, GONE_START, GONE_END);
  const skippedRows = parseTable(original, SKIP_START, SKIP_END);
  const skippedIds = new Set(skippedRows.map((r) => r.id));
  const labelled = new Map(
    [...goneRows, ...skippedRows, ...existingRows].map((r) => [r.id, r]),
  );

  let added = 0;
  const rows = spotifyAlbums
    // An album marked "niet labelen" stays out of the queue, however often we import.
    .filter((a) => !skippedIds.has(a.id))
    .map((a) => {
      const previous = labelled.get(a.id);
      if (!previous) added++;
      return {
        artist: a.artist,
        album: a.album,
        year: a.year,
        energy: previous?.energy ?? '',
        attention: previous?.attention ?? '',
        colour: previous?.colour ?? '',
        gem: previous?.gem ?? '',
        review: previous?.review ?? '',
        labelled: previous?.labelled ?? '',
        id: a.id,
      };
    });

  const savedIds = new Set(spotifyAlbums.map((a) => a.id));
  const gone = existingRows
    .filter((r) => !savedIds.has(r.id) && !r.id.startsWith('sample-'))
    .map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? ''])));

  const droppedSamples = existingRows.filter((r) => r.id.startsWith('sample-')).length;

  let updated = replaceBlock(original, renderTable(rows));
  updated = replaceBlock(
    updated,
    gone.length ? renderTable([...goneRows, ...gone]) : renderTable(goneRows),
    GONE_START,
    GONE_END,
  );
  updated = replaceBlock(updated, renderTable(skippedRows), SKIP_START, SKIP_END);
  await writeFile(labelPath, updated);

  const complete = rows.filter((r) => r.energy && r.attention && r.colour).length;
  console.log(`Updated ${labelPath}`);
  console.log(`  ${added} new album${added === 1 ? '' : 's'} to label`);
  console.log(`  ${complete} of ${rows.length} fully labelled`);
  if (gone.length) console.log(`  ${gone.length} no longer saved — moved down, labels kept`);
  if (skippedRows.length) console.log(`  ${skippedRows.length} on the "niet labelen" list`);
  if (droppedSamples) console.log(`  ${droppedSamples} sample rows removed`);
  console.log('\nNow run: npm run label');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});

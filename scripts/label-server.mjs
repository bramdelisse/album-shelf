// A small local page for labelling albums one at a time.
//
//     npm run label
//
// Serves http://127.0.0.1:8899 and writes straight into the label table in the
// vault, one album per save, so nothing is ever held in memory waiting to be
// lost. It also rewrites src/data/labels.json, which means a running
// `npm run dev` picks the new album up on the shelf immediately.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  COLUMNS,
  SKIP_END,
  SKIP_START,
  ensureBlock,
  parseStates,
  parseTable,
  renderTable,
  replaceBlock,
  rowsToLabels,
  today,
} from './label-table.mjs';
import { openBrowser } from './open-browser.mjs';

const SKIP_HEADING =
  '## Niet labelen\n\n' +
  '*Albums die ik bewust niet label. Verwijder de regel om er alsnog naar te kijken.*\n\n';

const PORT = 8899;
const UI = new URL('./label-ui.html', import.meta.url);
const CATALOGUE = new URL('../data/albums.json', import.meta.url);
const LABELS_OUT = new URL('../src/data/labels.json', import.meta.url);

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const labelPath = process.env.ALBUM_LABELS;

if (!labelPath || !existsSync(labelPath)) {
  console.error(
    labelPath
      ? `ALBUM_LABELS points at a file that does not exist:\n  ${labelPath}`
      : 'ALBUM_LABELS is not set. Put the path to albums.md in .env.',
  );
  process.exit(1);
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

/** Write one album's labels into the vault table, then refresh labels.json. */
async function saveLabel({ id, energy, attention, colour, gem, review, states }) {
  const text = await readFile(labelPath, 'utf8');
  const rows = parseTable(text);

  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`${id} is not in the label table. Run npm run import first.`);

  row.energy = String(energy);
  row.attention = String(attention);
  row.colour = String(colour).toLowerCase();
  row.gem = gem ? 'x' : '';
  row.review = (review ?? '').trim();
  // Only touch states when the page sent them, so a save that does not know
  // about states (an older tab, say) cannot wipe the ones already typed.
  if (states !== undefined) {
    row.states = parseStates(Array.isArray(states) ? states.join(',') : states).join(', ');
  }
  row.labelled = today();

  await writeFile(labelPath, replaceBlock(text, renderTable(rows)));

  const { labels } = rowsToLabels(rows);
  await writeFile(LABELS_OUT, JSON.stringify(labels, null, 2) + '\n');

  return Object.keys(labels).length;
}

/**
 * Move an album out of the labelling list into the "niet labelen" block.
 * It stays there across imports, so it does not come back the next time.
 */
async function skipAlbum({ id }) {
  let text = ensureBlock(await readFile(labelPath, 'utf8'), SKIP_START, SKIP_END, SKIP_HEADING);

  const rows = parseTable(text);
  const skipped = parseTable(text, SKIP_START, SKIP_END);

  if (skipped.some((r) => r.id === id)) return skipped.length; // already skipped, nothing to do

  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`${id} is not in the label table.`);

  const remaining = rows.filter((r) => r.id !== id);
  skipped.push(Object.fromEntries(COLUMNS.map((c) => [c, row[c] ?? ''])));

  text = replaceBlock(text, renderTable(remaining));
  text = replaceBlock(text, renderTable(skipped), SKIP_START, SKIP_END);
  await writeFile(labelPath, text);

  const { labels } = rowsToLabels(remaining);
  await writeFile(LABELS_OUT, JSON.stringify(labels, null, 2) + '\n');

  return skipped.length;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(UI));
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/data') {
      const albums = JSON.parse(await readFile(CATALOGUE, 'utf8'));
      const text = await readFile(labelPath, 'utf8');
      const rows = parseTable(text);
      const { labels } = rowsToLabels(rows);
      const dates = Object.fromEntries(rows.filter((r) => r.labelled).map((r) => [r.id, r.labelled]));
      const skipped = parseTable(text, SKIP_START, SKIP_END).map((r) => r.id);
      json(res, 200, { albums, labels, dates, skipped });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/label') {
      const payload = JSON.parse(await readBody(req));
      const total = await saveLabel(payload);
      console.log(`  saved ${payload.id} — ${total} labelled`);
      json(res, 200, { ok: true, total, labelled: today() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/skip') {
      const payload = JSON.parse(await readBody(req));
      const total = await skipAlbum(payload);
      console.log(`  not labelling ${payload.id} — ${total} in the skip list`);
      json(res, 200, { ok: true, total });
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    console.error(err.message);
    json(res, 500, { error: err.message });
  }
});

server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Close whatever is on it and run again.`
      : err.message,
  );
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\nLabelling ${labelPath}`);
  console.log(`Open ${url} — every save writes to the vault straight away.`);
  console.log('Close albums.md in Obsidian first, so the two do not fight over the file.');
  console.log('\nCtrl+C to stop.\n');
  openBrowser(url);
});

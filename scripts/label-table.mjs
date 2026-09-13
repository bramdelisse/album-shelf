// Read and write the label table that lives in the Obsidian vault.
//
// The vault file is the human's. This module only ever touches the block
// between the two markers, so any prose written around it survives an import.

export const START = '<!-- albums:start -->';
export const END = '<!-- albums:end -->';
export const GONE_START = '<!-- gone:start -->';
export const GONE_END = '<!-- gone:end -->';
export const SKIP_START = '<!-- skipped:start -->';
export const SKIP_END = '<!-- skipped:end -->';

export const COLUMNS = [
  'artist', 'album', 'year', 'energy', 'attention', 'colour', 'gem', 'review', 'labelled', 'id',
];

/** `gem` is a hand-typeable flag, so accept the obvious spellings. */
export const isGem = (v) => /^(x|y|yes|ja|true|1|★)$/i.test(String(v ?? '').trim());

/** Today, as YYYY-MM-DD in local time. */
export const today = () => new Date().toLocaleDateString('sv-SE');

const escapeCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const unescapeCell = (v) => v.replace(/\\\|/g, '|').trim();

// Split a markdown table row on unescaped pipes.
function splitRow(line) {
  const cells = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '\\|';
      i++;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  // A markdown row starts and ends with a pipe, so drop the empty edges.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(unescapeCell);
}

const isSeparator = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));

function blockBetween(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) return null;
  return text.slice(a + start.length, b);
}

/** Parse every row of the table inside the markers. Returns [] if absent. */
export function parseTable(text, start = START, end = END) {
  const block = blockBetween(text, start, end);
  if (block === null) return [];

  const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length === 0) return [];

  const header = splitRow(lines[0]).map((h) => h.toLowerCase());
  const rows = [];

  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    if (isSeparator(cells)) continue;
    const row = {};
    header.forEach((name, i) => {
      row[name] = cells[i] ?? '';
    });
    // The axis used to be called `place`. Read those files unchanged; they get
    // rewritten with the new header on the next save.
    if (row.attention === undefined && row.place !== undefined) row.attention = row.place;
    if (row.id) rows.push(row);
  }
  return rows;
}

/** Render rows as a markdown table. Column widths are not padded — Obsidian does not care. */
export function renderTable(rows) {
  const head = `| ${COLUMNS.join(' | ')} |`;
  const rule = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${COLUMNS.map((c) => escapeCell(r[c])).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

/**
 * Turn parsed rows into the { id: {energy, attention, colour} } map the site reads.
 * A row with nothing filled in is simply not labelled yet. A row with something
 * wrong in it is reported, not silently dropped and not fatal.
 */
export function rowsToLabels(rows) {
  const labels = {};
  const rejected = [];

  for (const row of rows) {
    const energy = Number(row.energy);
    const attention = Number(row.attention);
    const colour = (row.colour ?? '').trim();

    if (!row.energy && !row.attention && !colour) continue;

    const problems = [];
    if (!Number.isFinite(energy) || energy < 0 || energy > 100) problems.push('energy');
    if (!Number.isFinite(attention) || attention < 0 || attention > 100) problems.push('attention');
    if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(colour)) problems.push('colour');

    if (problems.length) {
      rejected.push(`${row.artist} — ${row.album}: check ${problems.join(', ')}`);
      continue;
    }
    labels[row.id] = { energy, attention, colour: colour.toLowerCase() };
    if (isGem(row.gem)) labels[row.id].gem = true;
    const review = (row.review ?? '').trim();
    if (review) labels[row.id].review = review;
  }
  return { labels, rejected };
}

/**
 * Add a marker pair to the file if it is not there yet, so a label file written
 * before this block existed keeps working. Placed above the Page description
 * callout when there is one, otherwise at the end.
 */
export function ensureBlock(text, start, end, heading = '') {
  if (text.includes(start) && text.includes(end)) return text;
  const block = `${heading}${start}\n${end}\n`;
  const anchor = text.indexOf('> [!note]- Page description');
  if (anchor !== -1) return text.slice(0, anchor) + block + '\n' + text.slice(anchor);
  return text.trimEnd() + '\n\n' + block;
}

/** Replace only the content between two markers, leaving the rest of the file alone. */
export function replaceBlock(text, inner, start = START, end = END) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(
      `Could not find the ${start} … ${end} markers in the label file.\n` +
        `They must both be present, on their own lines. Do not delete them.`,
    );
  }
  return text.slice(0, a + start.length) + '\n' + inner + '\n' + text.slice(b);
}

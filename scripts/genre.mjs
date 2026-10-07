// Broad genres, read off Spotify's artist genres.
//
// Unlike energy, attention and colour, a genre is not my opinion. It is a
// general agreement — that is what makes it useful for someone browsing a
// collection that is not theirs. So it is set by machine.
//
// Spotify gives genres per artist, not per album, and they are fine-grained
// ("dutch hip hop", "indie folk", "neo-classical"). Each one is mapped onto one
// of a handful of broad groups; the group that comes up most across an album's
// artists is the album's genre.
//
// Two places, two jobs. The raw Spotify genres are a cache in data/albums.json
// (`spotifyGenres`), so the mapping can change without asking Spotify again.
// The broad genre itself is a column in the label table in the vault, next to
// the labels, where it can be read — and corrected by hand if Spotify is wrong.

const API = 'https://api.spotify.com/v1';

/**
 * The broad groups, in the order they are tried. Order matters: "jazz rap" is
 * hip-hop, "pop punk" is rock, "electropop" is electronic. The first rule whose
 * pattern matches a Spotify genre wins.
 */
export const GENRES = [
  { name: 'soundtrack', match: /soundtrack|\bscore\b|video game|anime|musical|show tunes/ },
  { name: 'klassiek', match: /classical|orchestra|baroque|opera|choral|chamber music|string quartet|compositional|early music/ },
  { name: 'metal', match: /metal|blackgaze|djent|grindcore|deathcore|sludge|\bdoom\b/ },
  { name: 'hip-hop', match: /hip hop|hip-hop|\brap\b|trap|drill|grime|boom bap|nederhop|phonk/ },
  { name: 'jazz', match: /jazz|bebop|swing|big band|bossa nova/ },
  { name: 'ambient', match: /ambient|drone|new age|meditation|lo-fi|lofi|sleep|chillhop/ },
  { name: 'elektronisch', match: /edm|house|techno|trance|dubstep|drum and bass|dnb|electro|electronic|electronica|idm|breakbeat|uk garage|\bbass\b|hardstyle|future|synthwave|downtempo|trip hop|big room|chillwave|glitch/ },
  { name: 'rock', match: /rock|grunge|shoegaze|punk|emo|hardcore|psych|stoner|math/ },
  { name: 'soul & r&b', match: /r&b|rnb|soul|funk|motown|disco|blues|gospel/ },
  { name: 'folk', match: /folk|singer-songwriter|americana|bluegrass|country|acoustic/ },
  { name: 'wereld', match: /afro|reggae|dancehall|latin|reggaeton|salsa|samba|cumbia|flamenco|world|arabic|bollywood|fado|mpb/ },
  { name: 'pop', match: /pop|\bindie\b|schlager|levenslied|cantautor|chanson/ },
];

/** When an album's artists have no genres Spotify knows of, or none that map. */
export const OTHER = 'overig';

/** The broad group for one Spotify genre, or null if nothing matches. */
export function groupOf(spotifyGenre) {
  const g = String(spotifyGenre).toLowerCase();
  return GENRES.find((rule) => rule.match.test(g))?.name ?? null;
}

/** The album's genre: the most common group across its Spotify genres. */
export function albumGenre(spotifyGenres = []) {
  const counts = new Map();
  for (const sg of spotifyGenres) {
    const group = groupOf(sg);
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if (counts.size === 0) return OTHER;
  // Most common wins; on a tie, the earlier rule in GENRES wins.
  const order = GENRES.map((r) => r.name);
  return [...counts].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0][0];
}

/** Does this album still need its genres fetched? */
export const needsGenres = (album) => !Array.isArray(album.spotifyGenres);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, token) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 2);
      process.stdout.write(`\n  rate limited, waiting ${wait}s\n`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Spotify returned ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error(`Spotify kept rate limiting ${url}; try again later.`);
}

/** Album id -> artist ids, from the saved-albums list (50 per request). */
async function savedAlbumArtists(token, api) {
  const map = new Map();
  let url = `${api}/me/albums?limit=50`;
  while (url) {
    const page = await get(url, token);
    for (const item of page.items) map.set(item.album.id, item.album.artists.map((x) => x.id));
    url = page.next ? page.next.replace('https://api.spotify.com/v1', api) : null;
  }
  return map;
}

/**
 * Fetch the Spotify genres of every album that has none yet, into
 * `album.spotifyGenres`. Mutates `albums`; returns how many albums got genres.
 * Mapping them onto a broad genre is `albumGenre`'s job, not this one's.
 *
 * Spotify dropped the batch /artists endpoint in February 2026, so artists are
 * fetched one at a time, each once per run however many albums it has. If a
 * request fails halfway, the albums whose artists were all fetched keep their
 * genres and the error is rethrown — so a rerun only asks for the rest.
 */
export async function fillGenres(albums, token, { api = API, onProgress = () => {} } = {}) {
  const todo = albums.filter(needsGenres);
  if (!todo.length) return 0;

  if (todo.some((a) => !a.artistIds)) {
    const artistsOf = await savedAlbumArtists(token, api);
    for (const a of todo) if (!a.artistIds && artistsOf.has(a.id)) a.artistIds = artistsOf.get(a.id);
  }

  const artistIds = [...new Set(todo.flatMap((a) => a.artistIds ?? []))];
  const genresOf = new Map();
  let failure = null;
  try {
    for (const id of artistIds) {
      const artist = await get(`${api}/artists/${id}`, token);
      genresOf.set(id, artist.genres ?? []);
      onProgress(genresOf.size, artistIds.length);
      await sleep(60); // stay well under the rate limit
    }
  } catch (err) {
    failure = err;
  }

  let done = 0;
  for (const a of todo) {
    // No artist ids: the album is no longer saved in Spotify. Try again after the next import.
    if (!a.artistIds || !a.artistIds.every((id) => genresOf.has(id))) continue;
    a.spotifyGenres = [...new Set(a.artistIds.flatMap((id) => genresOf.get(id)))];
    done++;
  }

  if (failure) {
    failure.message += ` (${done} albums got their genres before it stopped)`;
    throw failure;
  }
  return done;
}

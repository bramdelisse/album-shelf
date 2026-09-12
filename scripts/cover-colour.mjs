// Pick the colour an album cover actually reads as.
//
// Not the average colour — averaging a cover gives mud. This buckets the
// pixels and takes the biggest bucket, with a thumb on the scale for
// saturation, because a washed-out grey is a useless default for a shelf
// where colour is supposed to carry a feeling.

// Bumped whenever the picking changes, so `npm run colours` re-reads covers it
// has already seen instead of serving a result from the old algorithm.
export const ALGO = 2;

let sharpModule;

async function loadSharp() {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = (await import('sharp')).default;
  } catch {
    throw new Error(
      'Could not load sharp, which is needed to read colours off the covers.\n' +
        'Run: npm install',
    );
  }
  return sharpModule;
}

function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const hex = (r, g, b) =>
  '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');

const BINS = 36; // 10° per bin
const DARK = 0.14; // below this it is shadow, not a colour
const GREY = 0.12; // below this saturation it is not a hue

/**
 * How much one pixel counts towards "the colour of this cover".
 *
 * Brightness matters, but sub-linearly, so a large dim area still competes with
 * a small bright one. Saturation matters because a colour you would name beats
 * a muddy one. This is the whole reason a dark hoodie no longer beats a sky.
 */
const weigh = (s, v) => Math.pow(v, 0.6) * (0.35 + 0.65 * s);

/**
 * Dominant colour of a raw RGB buffer, as a hex string, or null.
 *
 * Bins by hue rather than by RGB. A gradient sky spans dozens of RGB values but
 * only a couple of hues, so binning on RGB let any flat block — a jacket, a
 * shadow — beat it on count alone. Hue survives the gradient.
 */
export function dominantFromRaw(data) {
  const weight = new Float64Array(BINS);
  const acc = Array.from({ length: BINS }, () => ({ r: 0, g: 0, b: 0, w: 0 }));

  let chromatic = 0;
  let grey = { r: 0, g: 0, b: 0, w: 0 };

  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const { h, s, v } = rgbToHsv(r, g, b);

    if (v < DARK) continue; // shadow says nothing about the album

    if (s < GREY) {
      // Kept only as a fallback for covers that really are black and white.
      grey.r += r * v;
      grey.g += g * v;
      grey.b += b * v;
      grey.w += v;
      continue;
    }

    const w = weigh(s, v);
    const bin = Math.min(BINS - 1, Math.floor(h / (360 / BINS)));
    weight[bin] += w;
    acc[bin].r += r * w;
    acc[bin].g += g * w;
    acc[bin].b += b * w;
    acc[bin].w += w;
    chromatic++;
  }

  // A hue sitting on a bin boundary would otherwise split in two, so smooth
  // the histogram around the circle before looking for the peak.
  let peak = -1;
  let peakWeight = 0;
  for (let i = 0; i < BINS; i++) {
    const smoothed =
      0.25 * weight[(i - 1 + BINS) % BINS] + 0.5 * weight[i] + 0.25 * weight[(i + 1) % BINS];
    if (smoothed > peakWeight) {
      peakWeight = smoothed;
      peak = i;
    }
  }

  const enoughColour = chromatic >= (data.length / 3) * 0.02;
  if (peak === -1 || !enoughColour) {
    return grey.w > 0 ? hex(grey.r / grey.w, grey.g / grey.w, grey.b / grey.w) : null;
  }

  // Average the peak with its neighbours, so a hue spread over a boundary
  // contributes fully. The weights bias this towards the vivid end of the
  // range rather than its washed-out edges.
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (const i of [(peak - 1 + BINS) % BINS, peak, (peak + 1) % BINS]) {
    r += acc[i].r;
    g += acc[i].g;
    b += acc[i].b;
    w += acc[i].w;
  }
  return w > 0 ? hex(r / w, g / w, b / w) : null;
}

/** Download one cover and read its colour. Returns null if anything goes wrong. */
export async function colourFromUrl(url) {
  if (!url) return null;
  try {
    const sharp = await loadSharp();
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const { data } = await sharp(buf)
      .resize(64, 64, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return dominantFromRaw(data);
  } catch {
    return null;
  }
}

/** True when this album's colour is missing, from an older algorithm, or from a different cover. */
export const needsColour = (a) =>
  !a.coverColour || a.coverSource !== a.cover || a.colourAlgo !== ALGO;

/**
 * Fill in `coverColour` for every album that needs one.
 * Mutates the array. Albums already read with this algorithm are left alone,
 * so a second run costs nothing.
 */
export async function fillCoverColours(albums, { concurrency = 8, onProgress } = {}) {
  const todo = albums.filter((a) => a.cover && needsColour(a));
  const total = todo.length;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const album = todo.pop();
      if (!album) return;
      const colour = await colourFromUrl(album.cover);
      if (colour) {
        album.coverColour = colour;
        album.coverSource = album.cover;
        album.colourAlgo = ALGO;
      }
      done++;
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return done;
}

// Minimal dependency-free PNG encoder (rgba8, color type 6, 8-bit) shared by the geo bake
// tools. Uses only Node's built-in zlib for the IDAT deflate.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode an rgba8 pixel buffer (width*height*4, row-major) as a PNG Buffer.
 *
 * `opts.filter: 'adaptive'` picks a PNG row filter per scanline (None/Sub/Up/Average/Paeth, by the
 * usual minimum-sum-of-absolute-differences heuristic). Worth it for smooth, fully-valid global
 * fields (reanalysis, resampled grids), where unfiltered rows deflate poorly; the default stays
 * filter-less so re-running an existing bake reproduces its committed bytes.
 */
export function encodePng(width, height, rgba, opts = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const stridePx = width * 4;
  const raw = Buffer.alloc((stridePx + 1) * height);
  if (opts.filter === 'adaptive') {
    filterAdaptive(raw, rgba, stridePx, height);
  } else {
    for (let y = 0; y < height; y++) {
      raw[y * (stridePx + 1)] = 0; // filter: none
      rgba.copy(raw, y * (stridePx + 1) + 1, y * stridePx, (y + 1) * stridePx);
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Writes filtered scanlines into `raw`, choosing each row's filter by minimum |residual| sum. */
function filterAdaptive(raw, rgba, stridePx, height) {
  const bpp = 4;
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stridePx));
  for (let y = 0; y < height; y++) {
    const row = y * stridePx;
    const prev = y > 0 ? row - stridePx : -1;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let sum = 0;
      for (let i = 0; i < stridePx; i++) {
        const x = rgba[row + i];
        const a = i >= bpp ? rgba[row + i - bpp] : 0;
        const b = prev >= 0 ? rgba[prev + i] : 0;
        const c = prev >= 0 && i >= bpp ? rgba[prev + i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (x - pred) & 0xff;
        out[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum; best = f;
      }
    }
    raw[y * (stridePx + 1)] = best;
    cand[best].copy(raw, y * (stridePx + 1) + 1);
  }
}

// Bake equirectangular Earth basemaps for the geo_gis_explorer sample.
//
// The SST map paints the ocean through a scientific colormap and, previously, drew the land
// as flat grey. This bakes a natural-color land basemap so the continents read as real
// terrain, with the ocean/land split coming from the basemap's OWN high-resolution land mask
// (in alpha) rather than the coarse ~0.5° SST grid — so coastlines stay crisp. It also bakes
// the matching NIGHT map (city lights) for the sample's day/night terminator blend.
//
// Source: Solar System Scope Earth day/night maps (equirectangular, lon -180..180, lat +90..-90),
// licensed CC BY 4.0 — https://www.solarsystemscope.com/textures/ . Cloud-free, sun-glint-free,
// so the day map's ocean is a clean blue we can threshold into a land/sea mask.
//
// Writes:
//   assets/geo/earth_landmask.png   equirect gray8 land mask (255 = land, 0 = ocean) at
//                                    --mask-size, INDEPENDENT of the color basemap. The mask is
//                                    what clips the ocean data drape to the shore, so it wants far
//                                    more resolution than the backdrop colour does — and it costs
//                                    almost nothing to give it, because a two-valued image is
//                                    mostly flat runs and PNG packs it to a fraction of an RGBA
//                                    map at the same size.
//   assets/geo/earth_basemap.png    equirect rgba8: RGB = day-map color, A = land mask
//                                    (255 = land, 0 = ocean). Loaded srgb:false (displayed
//                                    as-is, matching how the SST colormap LUT is handled).
//   assets/geo/earth_nightmap.png   equirect rgba8: RGB = night lights over black, A = 255.
//
//   node tools/geo/bake_basemap.mjs [--size 4096] [--mask-size 8192] [--out DIR]

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib_png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

// CC BY 4.0 — Solar System Scope. 8k sources; we downsample to --size for modest committed assets.
const SOURCE = 'https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg';
const NIGHT_SOURCE = 'https://www.solarsystemscope.com/textures/download/8k_earth_nightmap.jpg';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const width = Math.max(256, parseInt(arg('--size', '4096'), 10));
const height = width / 2;   // equirectangular is always 2:1
// The mask is baked from the SAME source at its own (higher) size: the 8k source is native here, so
// asking for 8192 resamples nothing away.
const maskWidth = Math.max(width, parseInt(arg('--mask-size', '8192'), 10));
const maskHeight = maskWidth / 2;
const outDir = resolve(REPO, arg('--out', 'assets/geo'));

async function main() {
  process.stderr.write(`fetch ${SOURCE}\n`);
  const res = await fetch(SOURCE);
  if (!res.ok) {
    throw new Error(`source ${res.status}`);
  }
  const src = Buffer.from(await res.arrayBuffer());

  // Downsample to the target equirect size and pull raw RGB.
  const { data: rgb } = await sharp(src)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Classify ocean vs land per pixel and pack the color + mask into rgba8.
  // The day-map ocean is a clean blue (blue dominant, moderately dark); land (green/brown),
  // ice and desert are not blue-dominant. That single rule masks the continents cleanly.
  const rgba = Buffer.alloc(width * height * 4);
  let land = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const isOcean = b > r + 8 && b > g + 8 && b > 40;
    const a = isOcean ? 0 : 255;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
    if (!isOcean) {
      land++;
    }
  }

  mkdirSync(outDir, { recursive: true });

  // ── High-resolution land mask ────────────────────────────────────────────────────────
  // Same ocean rule, run at the mask's own size, written as gray8. The drape's coastline is only
  // ever as sharp as this: at 4096 a texel spans ~10 km, which is why the data bleeds visibly past
  // the shore. Classified at full size rather than upscaled from the colour pass — resampling a
  // mask interpolates its EDGE, which is the one part that matters.
  const { data: mrgb } = await sharp(src)
    .resize(maskWidth, maskHeight, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // The mask MUST live in ALPHA: the drape shader reads `landTex.a` (matching the basemap it
  // replaces), so writing it to RGB with an opaque alpha reads as "land everywhere" and clips the
  // whole ocean drape away. RGB carries it too, purely so the file is legible in an image viewer.
  const mask = Buffer.alloc(maskWidth * maskHeight * 4);
  for (let i = 0; i < maskWidth * maskHeight; i++) {
    const r = mrgb[i * 3], g = mrgb[i * 3 + 1], b = mrgb[i * 3 + 2];
    const v = (b > r + 8 && b > g + 8 && b > 40) ? 0 : 255;
    mask[i * 4] = v; mask[i * 4 + 1] = v; mask[i * 4 + 2] = v; mask[i * 4 + 3] = v;
  }
  const maskPng = encodePng(maskWidth, maskHeight, mask);
  const maskPath = resolve(outDir, 'earth_landmask.png');
  writeFileSync(maskPath, maskPng);
  process.stderr.write(
    `wrote mask ${maskWidth}x${maskHeight}, ${(maskPng.length / 1e6).toFixed(2)} MB
  ${maskPath}
`,
  );

  const png = encodePng(width, height, rgba);
  const outPath = resolve(outDir, 'earth_basemap.png');
  writeFileSync(outPath, png);
  process.stderr.write(
    `wrote ${width}x${height} (${((land / (width * height)) * 100).toFixed(1)}% land), ` +
    `${(png.length / 1e6).toFixed(2)} MB\n  ${outPath}\n`,
  );

  // Night map (city lights): plain RGB over black, no mask needed — lights exist only on land.
  // Half the day map's size is plenty; the lights are soft and it keeps the committed asset small.
  process.stderr.write(`fetch ${NIGHT_SOURCE}\n`);
  const nightRes = await fetch(NIGHT_SOURCE);
  if (!nightRes.ok) {
    throw new Error(`night source ${nightRes.status}`);
  }
  const nW = Math.min(width, 2048);
  const nH = nW / 2;
  const { data: nightRgb } = await sharp(Buffer.from(await nightRes.arrayBuffer()))
    .resize(nW, nH, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const nightRgba = Buffer.alloc(nW * nH * 4);
  for (let i = 0; i < nW * nH; i++) {
    nightRgba[i * 4] = nightRgb[i * 3];
    nightRgba[i * 4 + 1] = nightRgb[i * 3 + 1];
    nightRgba[i * 4 + 2] = nightRgb[i * 3 + 2];
    nightRgba[i * 4 + 3] = 255;
  }
  const nightPng = encodePng(nW, nH, nightRgba);
  const nightPath = resolve(outDir, 'earth_nightmap.png');
  writeFileSync(nightPath, nightPng);
  process.stderr.write(`wrote ${nW}x${nH} night map, ${(nightPng.length / 1e6).toFixed(2)} MB\n  ${nightPath}\n`);
}

main().catch((e) => {
  process.stderr.write(`bake_basemap failed: ${e.message}\n`);
  process.exit(1);
});

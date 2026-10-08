/**
 * Species occurrence density from OBIS — the Ocean Biodiversity Information System.
 *
 * OBIS aggregates hundreds of millions of marine occurrence records (museum collections, surveys,
 * tagging programmes, citizen science). Fetching them as points is hopeless in a browser — Atlantic
 * cod alone has over three million — so this uses OBIS's **gridded** endpoint, which returns a
 * GeoJSON cell grid with a record count per cell. All of humpback whale becomes ~3,400 cells and
 * about 600 KB, which is a field, not a point cloud, and therefore rides the same
 * {@link GriddedField} contract as every physical layer in the explorer.
 *
 * Counts are strongly log-distributed (1 → tens of thousands per cell), and they measure **sampling
 * effort as much as abundance**: the North Sea and the Gulf of Maine look busy partly because they
 * are surveyed relentlessly. Read it as "where this species has been recorded", not as a population
 * density map.
 *
 * Keyless and CORS-enabled, so it streams browser-direct like the ERDDAP feeds.
 *
 * @category Live
 */

import { GriddedField, rasterToTexture, type GriddedMeta } from './gridded_field.js';

const OBIS_API = 'https://api.obis.org/v3';

/** A species the explorer offers by default — scientific name plus how people refer to it. */
export interface ObisSpecies {
  /** Scientific name, as OBIS indexes it. */
  taxon: string;
  label: string;
  /** Rough group, for the picker's grouping. */
  group: 'Whales & dolphins' | 'Sharks & rays' | 'Fish' | 'Turtles' | 'Other';
}

/**
 * A starting menu spanning the groups people ask about. Any name OBIS indexes works — this list is
 * a convenience, not a limit, and {@link loadObisGrid} takes an arbitrary taxon.
 */
export const OBIS_SPECIES: readonly ObisSpecies[] = [
  { taxon: 'Megaptera novaeangliae', label: 'Humpback whale', group: 'Whales & dolphins' },
  { taxon: 'Balaenoptera musculus', label: 'Blue whale', group: 'Whales & dolphins' },
  { taxon: 'Physeter macrocephalus', label: 'Sperm whale', group: 'Whales & dolphins' },
  { taxon: 'Orcinus orca', label: 'Orca', group: 'Whales & dolphins' },
  { taxon: 'Eubalaena glacialis', label: 'N. Atlantic right whale', group: 'Whales & dolphins' },
  { taxon: 'Carcharodon carcharias', label: 'Great white shark', group: 'Sharks & rays' },
  { taxon: 'Rhincodon typus', label: 'Whale shark', group: 'Sharks & rays' },
  { taxon: 'Gadus morhua', label: 'Atlantic cod', group: 'Fish' },
  { taxon: 'Thunnus thynnus', label: 'Atlantic bluefin tuna', group: 'Fish' },
  { taxon: 'Scomber scombrus', label: 'Atlantic mackerel', group: 'Fish' },
  { taxon: 'Engraulis encrasicolus', label: 'European anchovy', group: 'Fish' },
  { taxon: 'Caretta caretta', label: 'Loggerhead turtle', group: 'Turtles' },
];

interface GridFeature {
  geometry: { coordinates: number[][][] };
  properties: { n: number };
}

/**
 * Loads one species' occurrence grid as a log-scaled {@link GriddedField}.
 *
 * `precision` is OBIS's grid level: 2 gives ~5.6° cells, 3 gives ~1.4° (the default — fine enough to
 * show a coastal shelf, small enough to stay under a megabyte), 4 gives ~0.35° and grows fast.
 *
 * Cells are painted into an equirect raster covering each polygon's own extent, so OBIS's grid
 * spacing does not have to match ours; overlapping cells keep the LARGER count, which matters only
 * at cell boundaries.
 */
export async function loadObisGrid(
  device: GPUDevice,
  taxon: string,
  opts: { precision?: number; max?: number } = {},
): Promise<GriddedField> {
  const precision = Math.max(1, Math.min(4, Math.round(opts.precision ?? 3)));
  const url = `${OBIS_API}/occurrence/grid/${precision}?scientificname=${encodeURIComponent(taxon)}`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`OBIS: HTTP ${r.status}`);
  }
  const json = await r.json() as { features?: GridFeature[] };
  const feats = json.features ?? [];
  if (feats.length === 0) {
    throw new Error(`OBIS has no gridded records for "${taxon}"`);
  }
  // A 0.25° raster resolves the finest grid OBIS will return here without wasting memory.
  const W = 1440, H = 720;
  const values = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  const rgba = new Uint8Array(W * H * 4);
  // Log scale: counts run 1 → tens of thousands, and a linear ramp would show only the few
  // most-surveyed cells on Earth.
  const min = 1;
  const max = Math.max(10, opts.max ?? feats.reduce((m, f) => Math.max(m, f.properties.n || 0), 0));
  const l0 = Math.log10(min);
  const span = Math.log10(max) - l0;
  for (const f of feats) {
    const n = f.properties?.n;
    const ring = f.geometry?.coordinates?.[0];
    if (!n || !ring || ring.length < 4) {
      continue;
    }
    let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
    for (const [lon, lat] of ring) {
      lonMin = Math.min(lonMin, lon); lonMax = Math.max(lonMax, lon);
      latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat);
    }
    const byte = Math.max(1, Math.min(255, Math.round(((Math.log10(Math.max(n, min)) - l0) / (span || 1)) * 255)));
    const x0 = Math.max(0, Math.floor(((lonMin + 180) / 360) * W));
    const x1 = Math.min(W - 1, Math.ceil(((lonMax + 180) / 360) * W) - 1);
    const y0 = Math.max(0, Math.floor(((90 - latMax) / 180) * H));
    const y1 = Math.min(H - 1, Math.ceil(((90 - latMin) / 180) * H) - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (byte > values[i]) {
          values[i] = byte;
        }
        mask[i] = 1;
      }
    }
  }
  for (let i = 0; i < values.length; i++) {
    if (mask[i]) {
      rgba[i * 4] = values[i]; rgba[i * 4 + 1] = values[i]; rgba[i * 4 + 2] = values[i];
      rgba[i * 4 + 3] = 255;
    }
  }
  const meta: GriddedMeta = {
    variable: taxon, source: 'OBIS (Ocean Biodiversity Information System)',
    date: `all records · grid ${precision}`,
    width: W, height: H, min, max, isLog: true, vector: false,
  };
  const texture = rasterToTexture(device, W, H, rgba, `Obis:${taxon}`);
  return new GriddedField(texture, meta, values, mask);
}

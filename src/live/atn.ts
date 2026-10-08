/**
 * Marine animal satellite tracks from the U.S. **Animal Telemetry Network** (ATN), served as
 * trajectory tables by the IOOS ERDDAP.
 *
 * Each row is one Argos or GPS fix from a tag glued, bolted or swallowed by a real animal, so this
 * is the one dataset here that is not a field at all: it is a set of paths. Every fix carries an
 * Argos location class and a QARTOD quality rollup, and the raw stream contains positions that are
 * plainly wrong — Argos least-squares fixes can land hundreds of kilometres away, and a track drawn
 * through them shows a whale teleporting inland. `qartod_rollup_flag=1` (QC passed) is therefore the
 * default, not an option.
 *
 * Keyless and browser-direct: erddap.ioos.us answers CORS preflights.
 *
 * @category Live
 */

const ATN_ERDDAP = 'https://erddap.ioos.us/erddap/tabledap/atn_cacheFromUrl_collection';

/** One tagged animal's path. */
export interface AtnTrack {
  /** ERDDAP trajectory id — one tag deployment. */
  id: string;
  taxon: string;
  /** Fixes in time order. */
  points: Array<{ lon: number; lat: number; t: number }>;
}

/** The taxa ATN has published through this collection, with names people use. */
export const ATN_TAXA: ReadonlyArray<{ taxon: string; label: string }> = [
  { taxon: 'Pseudorca crassidens', label: 'False killer whale' },
  { taxon: 'Globicephala macrorhynchus', label: 'Short-finned pilot whale' },
  { taxon: 'Mesoplodon densirostris', label: 'Blainville’s beaked whale' },
  { taxon: 'Carcharodon carcharias', label: 'Great white shark' },
  { taxon: 'Phoca vitulina', label: 'Harbour seal' },
  { taxon: 'Erignathus barbatus', label: 'Bearded seal' },
  { taxon: 'Histriophoca fasciata', label: 'Ribbon seal' },
  { taxon: 'Phoca largha', label: 'Spotted seal' },
];

/**
 * Loads every QC-passed track for one taxon, grouped by deployment and sorted in time.
 *
 * Tracks are split on two conditions, both of which exist to stop the renderer from drawing a
 * journey that never happened:
 *
 *  - a reporting **gap** over `maxGapDays` (default 30) — a tag that goes quiet for a month and
 *    resumes leaves a straight line across a basin, indistinguishable from a real migration;
 *  - an implied **speed** over `maxSpeedKmh` (default 12) — sustained swimming faster than that is
 *    not a marine mammal, it is a bad fix or two deployments sharing an id. The QARTOD rollup does
 *    not always catch these: a single mis-located position can pass its own range test.
 */
export async function loadAtnTracks(
  taxon: string,
  opts: { maxGapDays?: number; minPoints?: number; maxSpeedKmh?: number } = {},
): Promise<AtnTrack[]> {
  const q = 'trajectory,time,latitude,longitude'
    + `&taxon_name=%22${encodeURIComponent(taxon).replace(/%20/g, '%20')}%22`
    + '&qartod_rollup_flag=1';
  const r = await fetch(`${ATN_ERDDAP}.csv?${q}`);
  if (!r.ok) {
    throw new Error(`ATN: HTTP ${r.status}`);
  }
  const text = await r.text();
  const lines = text.split('\n');
  // ERDDAP CSV: row 0 is column names, row 1 is units — data starts at row 2.
  const byId = new Map<string, Array<{ lon: number; lat: number; t: number }>>();
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const c = line.split(',');
    if (c.length < 4) {
      continue;
    }
    const id = c[0];
    const t = Date.parse(c[1]);
    const lat = Number(c[2]);
    const lon = Number(c[3]);
    if (!id || !Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    let arr = byId.get(id);
    if (!arr) {
      arr = [];
      byId.set(id, arr);
    }
    arr.push({ lon, lat, t });
  }
  const gapMs = Math.max(1, opts.maxGapDays ?? 30) * 86400e3;
  const minPoints = Math.max(2, opts.minPoints ?? 4);
  const maxKmh = Math.max(1, opts.maxSpeedKmh ?? 12);
  /** Great-circle km between two fixes. */
  const distKm = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => {
    const d2r = Math.PI / 180;
    const la1 = a.lat * d2r, la2 = b.lat * d2r;
    return 2 * 6371 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2
      + Math.cos(la1) * Math.cos(la2) * Math.sin(((b.lon - a.lon) * d2r) / 2) ** 2));
  };
  const out: AtnTrack[] = [];
  for (const [id, pts] of byId) {
    pts.sort((a, b) => a.t - b.t);
    let run: Array<{ lon: number; lat: number; t: number }> = [];
    const flush = (): void => {
      if (run.length >= minPoints) {
        out.push({ id: out.length && run !== pts ? `${id}#${out.length}` : id, taxon, points: run });
      }
      run = [];
    };
    for (const p of pts) {
      const prev = run.length ? run[run.length - 1] : null;
      if (prev) {
        const dtH = (p.t - prev.t) / 3600e3;
        const tooFast = dtH > 0 && distKm(prev, p) / dtH > maxKmh;
        if (p.t - prev.t > gapMs || tooFast) {
          flush();
        }
      }
      run.push(p);
    }
    flush();
  }
  return out;
}

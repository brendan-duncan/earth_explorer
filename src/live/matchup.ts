/**
 * Station match-up extraction: "give me the satellite value at each of my sample points".
 *
 * This is the workflow that turns a data viewer into part of someone's actual analysis. A field
 * scientist arrives with a CSV of stations — a cruise track, a set of moorings, a list of reef
 * survey sites — and wants the gridded product collocated onto them, in time as well as space.
 * Drawing a polygon by hand answers a different, vaguer question.
 *
 * Pure and testable: no DOM, no fetch, no GPU. The caller supplies dated frames that know how to
 * sample themselves, so this module is the same whether the values come from a live ERDDAP stack or
 * a committed atlas.
 *
 * @category Live
 */

/** One row of the user's file. @category Live */
export interface Station {
  /** Identifier from the file, or a generated `row-N` when the file has no id column. */
  id: string;
  lon: number;
  lat: number;
  /** Requested observation time, epoch-ms, when the file carried a parseable one. */
  time?: number;
  /** 1-based line in the source file, so a warning can point at it. */
  line: number;
}

/** What {@link parseStationCsv} made of a file. @category Live */
export interface StationParse {
  stations: Station[];
  /** Header names that were used, so the UI can show what it guessed. */
  matched: { lon: string; lat: string; time?: string; id?: string };
  /** Rows dropped, with the reason — never silently, or a typo becomes missing data. */
  skipped: Array<{ line: number; reason: string }>;
  delimiter: string;
}

/** Thrown when a file cannot be read as a station list at all. @category Live */
export class StationParseError extends Error {}

/** Splits one delimited line, honoring double-quoted fields and doubled quotes inside them. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'; i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Header aliases, lowercased. Order matters: the first hit wins. */
const LON_KEYS = ['longitude', 'lon', 'long', 'lng', 'decimallongitude', 'x'];
const LAT_KEYS = ['latitude', 'lat', 'decimallatitude', 'y'];
const TIME_KEYS = ['time', 'date', 'datetime', 'timestamp', 'eventdate', 'date_time', 'utc'];
const ID_KEYS = ['id', 'station', 'station_id', 'name', 'site', 'sample', 'cast', 'label'];

function findColumn(headers: string[], keys: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));
  for (const k of keys) {
    const want = k.replace(/[\s_-]+/g, '');
    const i = lower.indexOf(want);
    if (i >= 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Reads a station list: any delimited text with recognizable longitude and latitude columns, plus
 * an optional time and id.
 *
 * Column names are guessed from a generous alias list (including Darwin Core's
 * `decimalLatitude`/`decimalLongitude`, so an OBIS or GBIF export drops straight in). Guessing is
 * reported back rather than assumed — the caller shows which headers were used, because silently
 * matching the wrong column is the failure mode that produces confident nonsense.
 * @category Live
 */
export function parseStationCsv(text: string): StationParse {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new StationParseError('the file has no data rows — expected a header line plus at least one station');
  }
  // Delimiter by counting candidates in the header: a comma inside a quoted name would otherwise
  // beat a genuine tab or semicolon.
  const delim = [',', '\t', ';'].reduce((best, d) =>
    splitLine(lines[0], d).length > splitLine(lines[0], best).length ? d : best, ',');
  const headers = splitLine(lines[0], delim);
  const iLon = findColumn(headers, LON_KEYS);
  const iLat = findColumn(headers, LAT_KEYS);
  if (iLon < 0 || iLat < 0) {
    throw new StationParseError(
      `no longitude/latitude columns found in "${headers.join(', ')}" — name them lon/longitude and lat/latitude (decimal degrees)`);
  }
  const iTime = findColumn(headers, TIME_KEYS);
  const iId = findColumn(headers, ID_KEYS);

  const stations: Station[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = splitLine(lines[r], delim);
    const line = r + 1;
    const lon = Number(cells[iLon]);
    const lat = Number(cells[iLat]);
    if (cells[iLon] === '' || cells[iLat] === '' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      skipped.push({ line, reason: 'longitude or latitude is missing or not a number' });
      continue;
    }
    if (lat < -90 || lat > 90) {
      skipped.push({ line, reason: `latitude ${lat} is outside −90..90 (are the columns swapped?)` });
      continue;
    }
    if (lon < -360 || lon > 360) {
      skipped.push({ line, reason: `longitude ${lon} is outside −360..360` });
      continue;
    }
    const station: Station = {
      // Fold 0–360 files into the −180..180 the samplers use; a station at 200°E is at −160°.
      id: iId >= 0 && cells[iId] ? cells[iId] : `row-${line}`,
      lon: lon > 180 ? lon - 360 : lon,
      lat,
      line,
    };
    if (iTime >= 0 && cells[iTime]) {
      const t = Date.parse(cells[iTime].length === 10 ? `${cells[iTime]}T12:00:00Z` : cells[iTime]);
      if (Number.isFinite(t)) {
        station.time = t;
      } else {
        skipped.push({ line, reason: `time "${cells[iTime]}" is not a date this can read (kept the station, ignored its time)` });
      }
    }
    stations.push(station);
  }
  if (stations.length === 0) {
    throw new StationParseError('no usable stations — every row was missing a valid longitude/latitude pair');
  }
  return {
    stations,
    matched: {
      lon: headers[iLon], lat: headers[iLat],
      time: iTime >= 0 ? headers[iTime] : undefined,
      id: iId >= 0 ? headers[iId] : undefined,
    },
    skipped,
    delimiter: delim === '\t' ? 'tab' : delim,
  };
}

// ── Collocation ──────────────────────────────────────────────────────────────────────

/** A dated frame that can report its value at a point. @category Live */
export interface MatchupFrame {
  /** `YYYY-MM-DD` or full ISO. */
  date: string;
  /** Physical value, or null where the product has no data (land, cloud, ice). */
  sample(lonDeg: number, latDeg: number): number | null;
}

/** One collocated station. @category Live */
export interface MatchupRow {
  station: Station;
  /** The frame actually used, or null when nothing fell inside the tolerance. */
  matchedDate: string | null;
  /** Signed days from the station's requested time to the matched frame (+ = frame is later). */
  lagDays: number | null;
  value: number | null;
  status: 'ok' | 'no-data' | 'no-frame';
}

/** @category Live */
export interface MatchupOptions {
  /**
   * Largest acceptable gap between a station's time and a frame's, in days. Stations outside it are
   * reported `no-frame` rather than silently matched to a distant date — a "match-up" that pairs a
   * June sample with a December image is not a match-up.
   */
  maxLagDays?: number;
  /** Frame to use for stations with no time of their own (default: the last frame). */
  fallbackDate?: string;
}

const DAY_MS = 86400e3;

function frameEpoch(date: string): number {
  return Date.parse(date.includes('T') ? date : `${date}T12:00:00Z`);
}

/**
 * Collocates each station onto the nearest frame in time, then samples that frame at the station's
 * position.
 *
 * The three outcomes are kept distinct on purpose. `no-frame` means the record does not cover that
 * station's date; `no-data` means it does, and the product has a gap there (land, cloud, ice). They
 * call for completely different responses, and a single blank cell would conflate them.
 * @category Live
 */
export function matchupStations(
  stations: Station[], frames: MatchupFrame[], opts: MatchupOptions = {},
): MatchupRow[] {
  if (frames.length === 0) {
    return stations.map((station) => ({ station, matchedDate: null, lagDays: null, value: null, status: 'no-frame' as const }));
  }
  const epochs = frames.map((f) => frameEpoch(f.date));
  const maxLagMs = (opts.maxLagDays ?? 16) * DAY_MS;
  const fallback = opts.fallbackDate
    ? frames.findIndex((f) => f.date.slice(0, 10) === opts.fallbackDate!.slice(0, 10))
    : frames.length - 1;
  const fallbackIdx = fallback >= 0 ? fallback : frames.length - 1;

  return stations.map((station): MatchupRow => {
    let idx = fallbackIdx;
    let lagDays: number | null = null;
    if (station.time !== undefined) {
      let best = -1, bestDt = Infinity;
      for (let i = 0; i < epochs.length; i++) {
        const dt = Math.abs(epochs[i] - station.time);
        if (dt < bestDt) {
          bestDt = dt; best = i;
        }
      }
      if (best < 0 || bestDt > maxLagMs) {
        return { station, matchedDate: null, lagDays: null, value: null, status: 'no-frame' };
      }
      idx = best;
      lagDays = (epochs[best] - station.time) / DAY_MS;
    }
    const raw = frames[idx].sample(station.lon, station.lat);
    // Normalize NaN to null here rather than passing it on: `value` is documented as `number|null`,
    // and a consumer that checks `!== null` would otherwise take a NaN for a measurement.
    const ok = raw !== null && Number.isFinite(raw);
    return {
      station,
      matchedDate: frames[idx].date.slice(0, 10),
      lagDays: lagDays === null ? null : Math.round(lagDays * 100) / 100,
      value: ok ? raw : null,
      status: ok ? 'ok' : 'no-data',
    };
  });
}

/** Header + rows for a match-up CSV export. @category Live */
export function matchupTable(rows: MatchupRow[], valueColumn: string): {
  header: string[]; rows: Array<Array<string | number>>;
} {
  return {
    header: ['station_id', 'longitude', 'latitude', 'requested_time', 'matched_frame', 'lag_days', valueColumn, 'status'],
    rows: rows.map((r) => [
      r.station.id,
      r.station.lon,
      r.station.lat,
      r.station.time !== undefined ? new Date(r.station.time).toISOString() : '',
      r.matchedDate ?? '',
      r.lagDays ?? '',
      r.value !== null && Number.isFinite(r.value) ? r.value : '',
      r.status,
    ]),
  };
}

/** Counts by outcome, for the one-line summary a user reads before trusting the file. */
export function matchupSummary(rows: MatchupRow[]): { ok: number; noData: number; noFrame: number; total: number } {
  let ok = 0, noData = 0, noFrame = 0;
  for (const r of rows) {
    if (r.status === 'ok') {
      ok++;
    } else if (r.status === 'no-data') {
      noData++;
    } else {
      noFrame++;
    }
  }
  return { ok, noData, noFrame, total: rows.length };
}

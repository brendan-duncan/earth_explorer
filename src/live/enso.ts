/**
 * ENSO (El Niño–Southern Oscillation) classification from the Niño 3.4 SST anomaly.
 *
 * The operational definition (NOAA CPC) drives everything here: the **Oceanic Niño Index** is the
 * 3-month running mean of SST anomaly averaged over the Niño 3.4 region (5°S–5°N, 170°W–120°W),
 * and an El Niño / La Niña **event** is ≥ 5 consecutive overlapping 3-month seasons at or beyond
 * ±0.5 °C. Official ONI is computed from ERSSTv5 with a re-centered 30-year climatology; this
 * module derives an OISST-flavored equivalent (OISST v2.1 anomalies vs. its 1971–2000 baseline),
 * which tracks the official index to within ~a tenth of a degree — right phase for every real
 * event, but not the certified number.
 *
 * Monthly means come from two places, merged behind one shape:
 *   - `tools/geo/bake_enso.mjs` bakes the 1981→now record from the CoastWatch ERDDAP (full OISST
 *     span, no CORS → Node) into a tiny committed JSON.
 *   - {@link fetchNino34Live} extends it browser-direct from the NCEI ERDDAP (CORS *), fetching
 *     only the Niño 3.4 box — a few KB per month, so monthly (vs. the map's 4-month time-lapse
 *     cadence) costs nothing.
 *
 * @category Live
 */

/** The Niño 3.4 region (degrees): 5°S–5°N, 170°W–120°W. @category Live */
export const NINO34_BOX = { latMin: -5, latMax: 5, lonMin: -170, lonMax: -120 } as const;

/** One calendar month's Niño 3.4 mean SST anomaly. @category Live */
export interface EnsoMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Box-mean SST anomaly, °C. */
  anom: number;
  /** How many daily snapshots the mean was formed from. */
  samples: number;
}

/** One overlapping 3-month season's ONI value, labeled by its CENTER month. @category Live */
export interface EnsoSeason {
  month: string;
  oni: number;
}

/** @category Live */
export type EnsoPhase = 'el-nino' | 'la-nina' | 'neutral';

/** A classified El Niño / La Niña event (≥ 5 consecutive qualifying seasons). @category Live */
export interface EnsoEvent {
  phase: 'el-nino' | 'la-nina';
  /** Center month of the first qualifying season, `YYYY-MM`. */
  start: string;
  /** Center month of the last qualifying season, `YYYY-MM`. */
  end: string;
  /** Signed ONI extreme within the event, °C. */
  peak: number;
}

/** ONI threshold (°C) and the CPC minimum run length (overlapping seasons) for an event. */
export const ONI_THRESHOLD = 0.5;
export const ONI_MIN_SEASONS = 5;

const monthKey = (y: number, m0: number): string => `${y}-${String(m0 + 1).padStart(2, '0')}`;

/** `YYYY-MM` → months since year 0 (consecutiveness checks, chart x-axes). @category Live */
export function monthOrdinal(month: string): number {
  const y = parseInt(month.slice(0, 4), 10);
  const m = parseInt(month.slice(5, 7), 10);
  return y * 12 + (m - 1);
}

/**
 * The ONI series: a centered 3-month running mean over CONSECUTIVE months (a gap in the record
 * breaks the window, it is never averaged across). Seasons are labeled by their center month, so
 * the series is one month shorter at each end.
 * @category Live
 */
export function oniSeasons(months: EnsoMonth[]): EnsoSeason[] {
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const out: EnsoSeason[] = [];
  for (let i = 1; i < sorted.length - 1; i++) {
    const a = sorted[i - 1], b = sorted[i], c = sorted[i + 1];
    if (monthOrdinal(b.month) - monthOrdinal(a.month) !== 1 || monthOrdinal(c.month) - monthOrdinal(b.month) !== 1) {
      continue;
    }
    out.push({ month: b.month, oni: (a.anom + b.anom + c.anom) / 3 });
  }
  return out;
}

/**
 * Classifies events per the CPC rule: at least {@link ONI_MIN_SEASONS} CONSECUTIVE seasons with
 * ONI ≥ +0.5 °C (El Niño) or ≤ −0.5 °C (La Niña). Shorter excursions stay neutral.
 * @category Live
 */
export function ensoEvents(seasons: EnsoSeason[]): EnsoEvent[] {
  const out: EnsoEvent[] = [];
  let run: EnsoSeason[] = [];
  let sign = 0;
  const flush = (): void => {
    if (sign !== 0 && run.length >= ONI_MIN_SEASONS) {
      let peak = run[0].oni;
      for (const s of run) {
        if (Math.abs(s.oni) > Math.abs(peak)) {
          peak = s.oni;
        }
      }
      out.push({ phase: sign > 0 ? 'el-nino' : 'la-nina', start: run[0].month, end: run[run.length - 1].month, peak });
    }
    run = [];
    sign = 0;
  };
  for (const s of seasons) {
    const sSign = s.oni >= ONI_THRESHOLD ? 1 : s.oni <= -ONI_THRESHOLD ? -1 : 0;
    const consecutive = run.length === 0 || monthOrdinal(s.month) - monthOrdinal(run[run.length - 1].month) === 1;
    if (sSign !== sign || !consecutive) {
      flush();
      sign = sSign;
    }
    if (sSign !== 0) {
      run.push(s);
    }
  }
  flush();
  return out;
}

/** The event containing `month` (`YYYY-MM`), or null when conditions were neutral. @category Live */
export function eventAt(events: EnsoEvent[], month: string): EnsoEvent | null {
  for (const e of events) {
    if (month >= e.start && month <= e.end) {
      return e;
    }
  }
  return null;
}

/** Conventional strength label from an event's peak ONI. @category Live */
export function strengthLabel(peak: number): string {
  const a = Math.abs(peak);
  if (a >= 2.0) {
    return 'very strong';
  }
  if (a >= 1.5) {
    return 'strong';
  }
  if (a >= 1.0) {
    return 'moderate';
  }
  return 'weak';
}

/** Merges live months over baked ones (same month → live wins; the bake's last month is partial). @category Live */
export function mergeEnsoMonths(baked: EnsoMonth[], live: EnsoMonth[]): EnsoMonth[] {
  const byMonth = new Map<string, EnsoMonth>();
  for (const m of baked) {
    byMonth.set(m.month, m);
  }
  for (const m of live) {
    byMonth.set(m.month, m);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Shape of the committed `assets/geo/enso_nino34.json` (written by `tools/geo/bake_enso.mjs`). @category Live */
export interface EnsoBakedJson {
  source: string;
  box: string;
  /** `[["1981-09", anomC, samples], …]` in month order. */
  months: [string, number, number][];
}

/** Parses the baked JSON's compact month tuples. @category Live */
export function parseBakedEnso(j: EnsoBakedJson): EnsoMonth[] {
  return j.months.map(([month, anom, samples]) => ({ month, anom, samples }));
}

// ── Live extension (NCEI ERDDAP, CORS *) ────────────────────────────────────────────────────────

const NCEI = 'https://www.ncei.noaa.gov/erddap/griddap';
const OISST_FINAL = 'ncdc_oisst_v2_avhrr_by_time_zlev_lat_lon';
const OISST_PRELIM = 'ncdc_oisst_v2_avhrr_prelim_by_time_zlev_lat_lon';

/** NCEI Tomcat 400s on raw `[`/`]` — percent-encode them (parens/colons/commas stay literal). */
const encodeQuery = (q: string): string => q.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

/** Fetches `anom` over the Niño 3.4 box for one time selector and returns per-day box means. */
async function fetchBoxDays(dataset: string, timeSel: string): Promise<Map<string, number>> {
  // NCEI's OISST grid runs 0..360 in longitude: 170°W–120°W = 190..240. Every ~4th cell (1°) is
  // plenty for a 50°-wide box mean, and keeps a month's fetch at a few KB.
  const q = `anom[${timeSel}][0][(${NINO34_BOX.latMin}):4:(${NINO34_BOX.latMax})][(${NINO34_BOX.lonMin + 360}):4:(${NINO34_BOX.lonMax + 360})]`;
  const res = await fetch(`${NCEI}/${dataset}.json?${encodeQuery(q)}`);
  if (!res.ok) {
    throw new Error(`${dataset}: HTTP ${res.status}`);
  }
  const { columnNames, rows } = (await res.json() as { table: { columnNames: string[]; rows: unknown[][] } }).table;
  const iTime = columnNames.indexOf('time');
  const iAnom = columnNames.indexOf('anom');
  const acc = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const v = r[iAnom] as number | null;
    if (v === null || v === undefined || Number.isNaN(v)) {
      continue;
    }
    const day = String(r[iTime]).slice(0, 10);
    const a = acc.get(day) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n++;
    acc.set(day, a);
  }
  const out = new Map<string, number>();
  for (const [day, a] of acc) {
    if (a.n > 0) {
      out.set(day, a.sum / a.n);
    }
  }
  return out;
}

/** Bins per-day box means into calendar-month means. */
export function monthsFromDays(days: Map<string, number>): EnsoMonth[] {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const [day, v] of days) {
    const m = day.slice(0, 7);
    const a = acc.get(m) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n++;
    acc.set(m, a);
  }
  return [...acc.entries()]
    .map(([month, a]) => ({ month, anom: a.sum / a.n, samples: a.n }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Streams the Niño 3.4 monthly anomaly from `sinceMonth` (`YYYY-MM`, inclusive) to now,
 * browser-direct from NCEI: the finalized OISST product first (covers 2020→~2 weeks ago), then
 * the preliminary product for the newest days. ~5-day sampling within each month.
 * @category Live
 */
export async function fetchNino34Live(sinceMonth: string): Promise<EnsoMonth[]> {
  const days = new Map<string, number>();
  try {
    for (const [d, v] of await fetchBoxDays(OISST_FINAL, `(${sinceMonth}-01T12:00:00Z):5:(last)`)) {
      days.set(d, v);
    }
  } catch { /* final may not reach sinceMonth (very stale bake) or be briefly down — prelim still adds the tail */ }
  try {
    for (const [d, v] of await fetchBoxDays(OISST_PRELIM, '0:5:last')) {
      if (!days.has(d) && d.slice(0, 7) >= sinceMonth) {
        days.set(d, v);
      }
    }
  } catch { /* last ~2 weeks stay missing; the finalized months still classify */ }
  return monthsFromDays(days);
}

/** The current UTC `YYYY-MM` — its mean is a month-to-date value, not a complete month. @category Live */
export function currentUtcMonth(now: Date = new Date()): string {
  return monthKey(now.getUTCFullYear(), now.getUTCMonth());
}

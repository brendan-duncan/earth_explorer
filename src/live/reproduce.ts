/**
 * Turns "what this map is showing" back into "the request that produced it".
 *
 * A screenshot of a data map is not a result anyone can check. What makes it checkable is the exact
 * query: which host, which dataset id, which variable, which timestamp, which decimation. All of
 * that is already known at the moment the app fetches — this module just renders it into forms a
 * person can paste somewhere else, so the explorer becomes the front door of someone's own analysis
 * rather than a terminus.
 *
 * Everything here is pure string building: no DOM, no fetch. The URLs are the SAME query the app
 * issued, with a different extension — not a reconstruction that might drift from it. That is the
 * whole point: a snippet that returns slightly different numbers than the screen is worse than none.
 *
 * @category Live
 */

/** The griddap request behind one displayed frame. @category Live */
export interface GriddapRequest {
  /** ERDDAP griddap base URLs, in the order the loader tries them. */
  servers: string[];
  /** Dataset ids, in the order the loader tries them. */
  datasets: string[];
  variable: string;
  /** Datasets with a depth/level axis need the extra `[0]` subscript. */
  hasLevel: boolean;
  /** ERDDAP time selector exactly as issued, e.g. `(2026-07-01T12:00:00Z)` or `(last)`. */
  timeSel: string;
  /** Decimation stride along both spatial axes. */
  stride: number;
  /**
   * Per-cell reduction applied over the selected time span, when the request covers a RANGE rather
   * than an instant. ERDDAP has no server-side temporal aggregation, so the reader has to be told
   * to do it themselves — a range request whose snippet quietly plots the first frame would not
   * reproduce the map it came from.
   */
  reduce?: 'max' | 'min' | 'mean';
}

/** ERDDAP response formats worth offering. `.htmlTable` is the browsable one. @category Live */
export type GriddapFormat = 'nc' | 'csv' | 'json' | 'htmlTable' | 'graph';

/**
 * The griddap query string, byte-for-byte what {@link "./gridded_field.ts".GriddedField.loadScalar}
 * builds. Kept in step with it deliberately: this is a promise that the URL returns the numbers on
 * screen.
 */
export function griddapQuery(r: GriddapRequest): string {
  const lvl = r.hasLevel ? '[0]' : '';
  return `${r.variable}[${r.timeSel}]${lvl}[0:${r.stride}:last][0:${r.stride}:last]`;
}

/** Percent-encodes the brackets ERDDAP needs, the way the loader's fetch does. */
function encodeQuery(q: string): string {
  return q.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
}

/**
 * Full URL for the request in one format. `graph` points at ERDDAP's own plotting page (`.graph`),
 * which takes no query — it is a place to explore the dataset, not a copy of this frame.
 */
export function griddapUrl(r: GriddapRequest, format: GriddapFormat): string {
  const server = r.servers[0] ?? '';
  const ds = r.datasets[0] ?? '';
  if (format === 'graph') {
    return `${server}/${ds}.graph`;
  }
  return `${server}/${ds}.${format}?${encodeQuery(griddapQuery(r))}`;
}

/** A lon/lat box in −180..180 / −90..90, as the user drew it. @category Live */
export interface ReproduceBox {
  lonMin: number; latMin: number; lonMax: number; latMax: number;
}

/** Everything the snippets need beyond the request itself. @category Live */
export interface ReproduceContext {
  request: GriddapRequest;
  /** Layer key as the explorer names it, for comments. */
  layerKey: string;
  /** Human label, e.g. "Sea-surface temp". */
  layerLabel: string;
  /** Physical unit label, for comments. */
  unit?: string;
  /** The drawn region, if the reader was scoped to one. */
  box?: ReproduceBox | null;
  /** Degrees per cell after decimation, for the comment. */
  resolutionDeg?: number;
}

/**
 * A latitude/longitude subset in xarray that does NOT assume a longitude convention.
 *
 * These products disagree: NCEI's OISST runs 0–360, Coral Reef Watch runs −180–180. Selecting with
 * raw bounds silently returns an empty array on the wrong one, so the snippet normalizes the axis
 * into −180..180 first and masks on that. Costs one line and cannot be wrong.
 */
function xarraySubset(box: ReproduceBox): string {
  return [
    '',
    '# The drawn region. Longitude convention varies by product (0-360 vs -180-180),',
    '# so normalize the axis before selecting rather than assuming one.',
    'lon = ((ds.longitude + 180) % 360) - 180',
    `sel = ds.where((lon >= ${box.lonMin.toFixed(4)}) & (lon <= ${box.lonMax.toFixed(4)})`,
    `               & (ds.latitude >= ${box.latMin.toFixed(4)}) & (ds.latitude <= ${box.latMax.toFixed(4)}), drop=True)`,
  ].join('\n');
}

/**
 * Python that reopens exactly this frame. `xr.open_dataset` on the `.nc` URL rather than an
 * erddapy constraint block: the URL already encodes the subset the app asked for, so there is no
 * second expression of the query that could disagree with the first.
 * @category Live
 */
export function pythonSnippet(ctx: ReproduceContext): string {
  const url = griddapUrl(ctx.request, 'nc');
  const lines = [
    `# ${ctx.layerLabel} (${ctx.layerKey})${ctx.unit ? `, ${ctx.unit}` : ''} — the exact frame shown in the Earth Explorer.`,
    `# Variable ${ctx.request.variable}, time ${ctx.request.timeSel.replace(/[()]/g, '')}`
      + `${ctx.resolutionDeg ? `, every ${ctx.request.stride}${ctx.request.stride === 1 ? 'st' : ctx.request.stride === 2 ? 'nd' : ctx.request.stride === 3 ? 'rd' : 'th'} grid cell (~${ctx.resolutionDeg.toFixed(2)}°)` : ''}.`,
    '# pip install xarray netcdf4',
    'import xarray as xr',
    '',
    `ds = xr.open_dataset("${url}")`,
    `da = ds["${ctx.request.variable}"]`,
  ];
  if (ctx.request.reduce) {
    // The map is a per-cell reduction over the day's steps, so the snippet has to perform it too.
    // ERDDAP cannot do this server-side; without these two lines the reader plots 00:00 UTC and
    // wonders why their figure disagrees with the screenshot.
    lines.push(
      '',
      `# The map shows the daily ${ctx.request.reduce} per cell, reduced over the day's time steps.`,
      `da = da.${ctx.request.reduce}(dim="time")`,
    );
  }
  if (ctx.box) {
    lines.push(xarraySubset(ctx.box));
    lines.push('', `print(sel["${ctx.request.variable}"].mean().values)`);
  } else {
    lines.push('', 'print(da)');
  }
  return lines.join('\n');
}

/**
 * R equivalent. Same reasoning as the Python: fetch the URL the app fetched, then open it, instead
 * of restating the query through `rerddap`'s constraint API.
 * @category Live
 */
export function rSnippet(ctx: ReproduceContext): string {
  const url = griddapUrl(ctx.request, 'nc');
  return [
    `# ${ctx.layerLabel} (${ctx.layerKey}) — the exact frame shown in the Earth Explorer.`,
    '# install.packages(c("ncdf4"))',
    'library(ncdf4)',
    '',
    `url <- "${url}"`,
    'tmp <- tempfile(fileext = ".nc")',
    'download.file(url, tmp, mode = "wb")',
    'nc <- nc_open(tmp)',
    `v <- ncvar_get(nc, "${ctx.request.variable}")`,
    'lat <- ncvar_get(nc, "latitude"); lon <- ncvar_get(nc, "longitude")',
    'str(v)',
  ].join('\n');
}

/** A dataset citation, as the layer-info table carries it. @category Live */
export interface CitationFields {
  product: string;
  provider: string;
  access: string;
  url: string;
  license?: string;
}

/**
 * A citation with the two things a reader cannot recover later: the ACCESS DATE (these are living
 * feeds — the same query returns different numbers next month, and near-real-time products are
 * revised) and the exact subset used.
 * @category Live
 */
export function citationText(cite: CitationFields, ctx: ReproduceContext, accessedISO: string): string {
  const year = accessedISO.slice(0, 4);
  const lines = [
    `${cite.provider} (${year}). ${cite.product}. Accessed ${accessedISO} via ${cite.access}. ${cite.url}`,
  ];
  const subset = [
    `variable ${ctx.request.variable}`,
    `time ${ctx.request.timeSel.replace(/[()]/g, '')}${ctx.request.reduce ? `, per-cell daily ${ctx.request.reduce}` : ''}`,
    ctx.box
      ? `region ${ctx.box.lonMin.toFixed(3)}..${ctx.box.lonMax.toFixed(3)}°E, ${ctx.box.latMin.toFixed(3)}..${ctx.box.latMax.toFixed(3)}°N`
      : 'global',
    ctx.resolutionDeg ? `~${ctx.resolutionDeg.toFixed(2)}° (every ${ctx.request.stride} grid cell${ctx.request.stride === 1 ? '' : 's'})` : '',
  ].filter(Boolean);
  lines.push(`Subset used: ${subset.join('; ')}.`);
  if (cite.license) {
    lines.push(`License: ${cite.license}.`);
  }
  lines.push(`Request: ${griddapUrl(ctx.request, 'nc')}`);
  return lines.join('\n');
}

import { describe, it, expect } from 'vitest';
import {
  citationText, griddapQuery, griddapUrl, pythonSnippet, rSnippet,
  type GriddapRequest, type ReproduceContext,
} from '../../src/live/reproduce.js';

const REQ: GriddapRequest = {
  servers: ['https://www.ncei.noaa.gov/erddap/griddap'],
  datasets: ['ncdc_oisst_v2_avhrr_by_time_zlev_lat_lon'],
  variable: 'sst',
  hasLevel: true,
  timeSel: '(2026-07-01T12:00:00Z)',
  stride: 2,
};

const CTX: ReproduceContext = {
  request: REQ,
  layerKey: 'sst',
  layerLabel: 'Sea-surface temp',
  unit: 'degC',
  resolutionDeg: 0.5,
};

describe('griddapQuery', () => {
  // This is a promise, not a convenience: the URL has to return the numbers that were on screen.
  it('matches the query GriddedField.loadScalar builds', () => {
    expect(griddapQuery(REQ)).toBe('sst[(2026-07-01T12:00:00Z)][0][0:2:last][0:2:last]');
  });

  it('omits the level subscript for datasets without a depth axis', () => {
    expect(griddapQuery({ ...REQ, hasLevel: false }))
      .toBe('sst[(2026-07-01T12:00:00Z)][0:2:last][0:2:last]');
  });

  it('carries the stride through, so an export states the resolution it really has', () => {
    expect(griddapQuery({ ...REQ, stride: 1 })).toContain('[0:1:last][0:1:last]');
  });
});

describe('griddapUrl', () => {
  it('percent-encodes the brackets ERDDAP needs', () => {
    const url = griddapUrl(REQ, 'nc');
    expect(url.startsWith('https://www.ncei.noaa.gov/erddap/griddap/ncdc_oisst_v2_avhrr_by_time_zlev_lat_lon.nc?')).toBe(true);
    expect(url).toContain('%5B');
    expect(url).not.toContain('[');
  });

  it('only the extension changes between formats — one query, several renderings', () => {
    const q = griddapUrl(REQ, 'nc').split('?')[1];
    expect(griddapUrl(REQ, 'csv').split('?')[1]).toBe(q);
    expect(griddapUrl(REQ, 'json').split('?')[1]).toBe(q);
    expect(griddapUrl(REQ, 'htmlTable').split('?')[1]).toBe(q);
  });

  it('the dataset page takes no query — it is a place to explore, not a copy of this frame', () => {
    expect(griddapUrl(REQ, 'graph')).toBe(
      'https://www.ncei.noaa.gov/erddap/griddap/ncdc_oisst_v2_avhrr_by_time_zlev_lat_lon.graph');
  });

  it('uses the first server/dataset — the one the loader actually reached', () => {
    const url = griddapUrl({ ...REQ, servers: ['https://a', 'https://b'], datasets: ['first', 'second'] }, 'csv');
    expect(url.startsWith('https://a/first.csv?')).toBe(true);
  });
});

describe('pythonSnippet', () => {
  it('opens the exact .nc URL rather than restating the query', () => {
    const py = pythonSnippet(CTX);
    expect(py).toContain(griddapUrl(REQ, 'nc'));
    expect(py).toContain('import xarray as xr');
    expect(py).toContain('ds["sst"]');
  });

  it('normalizes longitude before subsetting, because the products disagree on the convention', () => {
    // NCEI's OISST runs 0-360 and Coral Reef Watch runs -180-180; selecting with raw bounds
    // silently returns nothing on the wrong one.
    const py = pythonSnippet({ ...CTX, box: { lonMin: -158.5, latMin: 20.9, lonMax: -157.6, latMax: 21.6 } });
    expect(py).toContain('((ds.longitude + 180) % 360) - 180');
    expect(py).toContain('-158.5000');
    expect(py).toContain('21.6000');
  });

  it('says which frame and which resolution it is, in a comment that survives a paste', () => {
    const py = pythonSnippet(CTX);
    expect(py).toContain('2026-07-01T12:00:00Z');
    expect(py).toContain('0.50°');
  });
});

describe('rSnippet', () => {
  it('downloads the same URL and opens the same variable', () => {
    const r = rSnippet(CTX);
    expect(r).toContain(griddapUrl(REQ, 'nc'));
    expect(r).toContain('ncvar_get(nc, "sst")');
  });
});

describe('citationText', () => {
  const CITE = {
    product: 'OISST v2.1',
    provider: 'NOAA NCEI',
    access: 'NCEI ERDDAP',
    url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst',
    license: 'public domain',
  };

  it('carries the ACCESS DATE — these are living feeds and the same query drifts', () => {
    const t = citationText(CITE, CTX, '2026-07-28');
    expect(t).toContain('NOAA NCEI (2026)');
    expect(t).toContain('Accessed 2026-07-28');
    expect(t).toContain(CITE.url);
    expect(t).toContain('License: public domain');
  });

  it('states the exact subset, not just the product', () => {
    const t = citationText(CITE, CTX, '2026-07-28');
    expect(t).toContain('variable sst');
    expect(t).toContain('time 2026-07-01T12:00:00Z');
    expect(t).toContain('global');
    expect(t).toContain('0.50°');
  });

  it('names the drawn region when the reader was scoped to one', () => {
    const t = citationText(CITE, { ...CTX, box: { lonMin: -158.5, latMin: 20.9, lonMax: -157.6, latMax: 21.6 } }, '2026-07-28');
    expect(t).toContain('region -158.500..-157.600°E, 20.900..21.600°N');
    expect(t).not.toContain('global');
  });

  it('includes the request itself, so the citation is checkable without the app', () => {
    expect(citationText(CITE, CTX, '2026-07-28')).toContain(griddapUrl(REQ, 'nc'));
  });

  it('omits the license line when the product does not state one', () => {
    const { license: _license, ...noLicense } = CITE;
    expect(citationText(noLicense, CTX, '2026-07-28')).not.toContain('License:');
  });
});

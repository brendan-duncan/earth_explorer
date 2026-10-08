import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadWildfires, loadForestUnits, formatAcres, hotspotColor,
} from '../../src/live/wildfire.js';

function point(props: object, lon: number, lat: number): object {
  return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

/** Perimeter + incident + hotspot responses, in the order loadWildfires issues them. */
function fakeFeeds(): Array<Record<string, unknown> | Error> {
  return [
    // Perimeters. The mapped polygon is the authority on size.
    { features: [{
      type: 'Feature',
      properties: {
        poly_IncidentName: 'Frijoles', poly_GISAcres: 8196.7, poly_DateCurrent: 1786751500000,
        attr_IrwinID: 'ABC-123', attr_IncidentSize: 8921, attr_PercentContained: 0,
        attr_IncidentTypeCategory: 'WF',
      },
      geometry: { type: 'Polygon', coordinates: [[[-105.9, 35.9], [-105.8, 35.9], [-105.8, 36.0]]] },
    }] },
    // Incidents: one mapped (stale DiscoveryAcres), one unmapped, one prescribed burn.
    { features: [
      point({ IrwinID: 'ABC-123', IncidentName: 'Frijoles', IncidentTypeCategory: 'WF', DiscoveryAcres: 3, PercentContained: 0, FireDiscoveryDateTime: 1785891420000, FireCause: 'Natural', POOState: 'US-NM', TotalIncidentPersonnel: 544, IncidentComplexityLevel: 'Type 2 Incident', PrimaryFuelModel: 'Timber' }, -105.848, 35.909),
      point({ IrwinID: 'DEF-456', IncidentName: 'Rito Torito', IncidentTypeCategory: 'WF', DiscoveryAcres: 0.1, POOState: 'US-NM' }, -105.558, 35.701),
      point({ IrwinID: 'GHI-789', IncidentName: 'Unit 7 Burn', IncidentTypeCategory: 'RX', DiscoveryAcres: 40, POOState: 'US-NM' }, -106.1, 35.4),
    ] },
    // Hotspots.
    { features: [
      point({ frp: 120, bright_ti4: 340.7, confidence: 'high', hours_old: 2, daynight: 'N' }, -105.85, 35.91),
      point({ frp: 4.5, bright_ti4: 314, confidence: 'nominal', hours_old: 20, daynight: 'D' }, -105.84, 35.92),
    ] },
  ];
}

function mockFetch(bodies: Array<Record<string, unknown> | Error>): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(() => {
    const body = bodies[i++];
    if (body instanceof Error) {
      return Promise.reject(body);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('formatAcres / hotspotColor', () => {
  it('formats acreage the way a fire is reported', () => {
    expect(formatAcres(8921)).toBe('8,921 ac');
    expect(formatAcres(0.25)).toBe('0.3 ac');
    expect(formatAcres(null)).toBe('size unreported');
  });

  it('ramps hotspot color by radiative power', () => {
    expect(hotspotColor(200)).not.toBe(hotspotColor(50));
    expect(hotspotColor(50)).not.toBe(hotspotColor(5));
  });
});

describe('loadWildfires', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('joins incidents to their mapped perimeter by IRWIN id', async () => {
    mockFetch(fakeFeeds());
    const snap = await loadWildfires();
    const frijoles = snap.incidents.find((i) => i.name === 'Frijoles')!;
    // The incident's own DiscoveryAcres (3) is what it was when someone first saw it; the mapped
    // polygon says 8,921, and that is the number a reader needs.
    expect(frijoles.acres).toBe(8921);
    expect(frijoles.mapped).toBe(true);
    expect(frijoles.personnel).toBe(544);
    expect(frijoles.state).toBe('NM');
    expect(snap.incidents.find((i) => i.name === 'Rito Torito')!.mapped).toBe(false);
  });

  it('flags prescribed burns so they are not drawn as wildfires', async () => {
    mockFetch(fakeFeeds());
    const snap = await loadWildfires();
    expect(snap.incidents.find((i) => i.name === 'Unit 7 Burn')!.prescribed).toBe(true);
    expect(snap.incidents.find((i) => i.name === 'Frijoles')!.prescribed).toBe(false);
  });

  it('orders incidents biggest first, since labels are placed in that order', async () => {
    mockFetch(fakeFeeds());
    const snap = await loadWildfires();
    expect(snap.incidents.map((i) => i.name)).toEqual(['Frijoles', 'Unit 7 Burn', 'Rito Torito']);
  });

  it('decodes perimeters and hotspots', async () => {
    mockFetch(fakeFeeds());
    const snap = await loadWildfires();
    expect(snap.perimeters).toHaveLength(1);
    expect(snap.perimeters[0].rings[0]).toHaveLength(3);
    expect(snap.perimeters[0].acres).toBe(8921);
    expect(snap.hotspots.map((h) => h.frp)).toEqual([120, 4.5]);
    expect(snap.hotspots[0].night).toBe(true);
    expect(snap.hotspots[1].night).toBe(false);
  });

  it('reports truncation so a capped view cannot be read as the whole picture', async () => {
    mockFetch(fakeFeeds());
    expect((await loadWildfires({ maxHotspots: 2 })).hotspotsTruncated).toBe(true);
    mockFetch(fakeFeeds());
    expect((await loadWildfires({ maxHotspots: 3000 })).hotspotsTruncated).toBe(false);
  });

  it('bounds only the hotspot query — a fire must not vanish when its edge leaves the screen', async () => {
    const fn = mockFetch(fakeFeeds());
    await loadWildfires({ bbox: { west: -107, south: 35, east: -105, north: 37 } });
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).not.toContain('esriGeometryEnvelope');   // perimeters: national
    expect(urls[1]).not.toContain('esriGeometryEnvelope');   // incidents: national
    expect(urls[2]).toContain('esriGeometryEnvelope');       // hotspots: viewport
  });

  it('survives a dead feed but not a dead service', async () => {
    const bodies = fakeFeeds();
    bodies[2] = new Error('hotspot service down');
    mockFetch(bodies);
    const snap = await loadWildfires();
    expect(snap.hotspots).toEqual([]);
    expect(snap.perimeters).toHaveLength(1);

    mockFetch([new Error('offline'), new Error('offline'), new Error('offline')]);
    await expect(loadWildfires()).rejects.toThrow('offline');
  });
});

describe('loadForestUnits', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads the lower-cased field names the EDW GeoJSON output uses', async () => {
    mockFetch([{ features: [{
      type: 'Feature',
      properties: { forestname: 'Santa Fe National Forest', region: '03', gis_acres: 1681821.1 },
      geometry: { type: 'MultiPolygon', coordinates: [[[[-106, 35], [-105, 35], [-105, 36]]]] },
    }] }]);
    const [unit] = await loadForestUnits({ west: -107, south: 34, east: -105, north: 37 });
    expect(unit.name).toBe('Santa Fe National Forest');
    expect(unit.region).toBe('03');
    expect(unit.rings).toHaveLength(1);
  });

  it('passes the simplification tolerance upstream instead of drawing full-fidelity edges', async () => {
    const fn = mockFetch([{ features: [] }]);
    await loadForestUnits({ west: -107, south: 34, east: -105, north: 37 }, { simplify: 0.05 });
    expect(String(fn.mock.calls[0][0])).toContain('maxAllowableOffset=0.05');
  });
});

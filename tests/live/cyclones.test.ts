import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadActiveCyclones, geometryPaths, saffirSimpson, cycloneClass, cycloneColor,
} from '../../src/live/cyclones.js';

describe('saffirSimpson', () => {
  it('maps knots onto the scale at its published boundaries', () => {
    expect(saffirSimpson(63)).toBe(0);
    expect(saffirSimpson(64)).toBe(1);
    expect(saffirSimpson(82)).toBe(1);
    expect(saffirSimpson(83)).toBe(2);
    expect(saffirSimpson(96)).toBe(3);
    expect(saffirSimpson(113)).toBe(4);
    expect(saffirSimpson(137)).toBe(5);
    expect(saffirSimpson(200)).toBe(5);
  });

  it('labels the sub-hurricane stages, which the category scale does not cover', () => {
    expect(cycloneClass(20)).toBe('Trop. depression');
    expect(cycloneClass(45)).toBe('Trop. storm');
    expect(cycloneClass(65)).toBe('Cat 1');
    expect(cycloneColor(20)).not.toBe(cycloneColor(45));
  });
});

describe('geometryPaths', () => {
  it('flattens every geometry the advisory layers can return', () => {
    expect(geometryPaths(null)).toEqual([]);
    expect(geometryPaths({ type: 'LineString', coordinates: [[1, 2], [3, 4]] }))
      .toEqual([[{ lon: 1, lat: 2 }, { lon: 3, lat: 4 }]]);
    expect(geometryPaths({ type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] }))
      .toHaveLength(2);
    // A polygon's holes come back as further rings, so the count is rings, not polygons.
    expect(geometryPaths({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]], [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4]]] }))
      .toHaveLength(2);
    expect(geometryPaths({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1]]], [[[5, 5], [6, 5], [6, 6]]]] }))
      .toHaveLength(2);
  });

  it('drops degenerate parts rather than emitting one-point paths', () => {
    expect(geometryPaths({ type: 'LineString', coordinates: [[1, 2]] })).toEqual([]);
    expect(geometryPaths({ type: 'LineString', coordinates: [[1, 2], 'nope', [3, 4]] }))
      .toEqual([[{ lon: 1, lat: 2 }, { lon: 3, lat: 4 }]]);
  });
});

/** One GeoJSON FeatureCollection per service layer, in the order loadActiveCyclones queries them. */
function fakeService(): Array<Record<string, unknown> | Error> {
  const point = (props: object, lon: number, lat: number): object =>
    ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
  return [
    // 1 — observed positions, deliberately out of time order.
    { features: [
      point({ STORMNAME: 'Lala', STORMID: 'cp012026', BASIN: 'cp', DTG: 2000, INTENSITY: 65, MSLP: 988, STORMTYPE: 'Hurricane1' }, -155, 17.9),
      point({ STORMNAME: 'Lala', STORMID: 'cp012026', BASIN: 'cp', DTG: 1000, INTENSITY: 55, MSLP: 991, STORMTYPE: 'Tropical Storm' }, -154.1, 17.8),
    ] },
    // 0 — forecast positions. 9999 is the feed's "missing" sentinel, not a value.
    { features: [
      point({ STORMNAME: 'Lala', BASIN: 'CP', ADVDATE: 10_000, ADVISNUM: '14', TAU: 12, MAXWIND: 50, GUST: 60, MSLP: 9999, TCDIR: 9999, TCSPD: 9999, ITCDVLP: 'Tropical Storm', FLDATELBL: 'later' }, -157, 19.3),
      point({ STORMNAME: 'Lala', BASIN: 'CP', ADVDATE: 10_000, ADVISNUM: '14', TAU: 0, MAXWIND: 65, GUST: 80, MSLP: 988, TCDIR: 305, TCSPD: 7, ITCDVLP: 'Category 1 Hurricane', FLDATELBL: 'now' }, -155.2, 18.2),
    ] },
    // 3 — observed track.
    { features: [{ type: 'Feature', properties: { STORMNAME: 'Lala' }, geometry: { type: 'LineString', coordinates: [[-154.1, 17.8], [-155, 17.9]] } }] },
    // 2 — forecast track.
    { features: [{ type: 'Feature', properties: { STORMNAME: 'Lala' }, geometry: { type: 'LineString', coordinates: [[-155.2, 18.2], [-157, 19.3]] } }] },
    // 4 — cone.
    { features: [{ type: 'Feature', properties: { STORMNAME: 'Lala' }, geometry: { type: 'Polygon', coordinates: [[[-155, 18], [-157, 19], [-157, 18]]] } }] },
    // 5 — watches/warnings, including a code we do not draw.
    { features: [
      { type: 'Feature', properties: { STORMNAME: 'Lala', TCWW: 'HWR' }, geometry: { type: 'LineString', coordinates: [[-155.9, 19.5], [-155.1, 19.7]] } },
      { type: 'Feature', properties: { STORMNAME: 'Lala', TCWW: 'XYZ' }, geometry: { type: 'LineString', coordinates: [[-1, 1], [-2, 2]] } },
    ] },
  ];
}

function mockFetch(bodies: Array<Record<string, unknown> | Error>): void {
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(() => {
    const body = bodies[i++];
    if (body instanceof Error) {
      return Promise.reject(body);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

describe('loadActiveCyclones', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('assembles one storm out of six independent layer queries', async () => {
    mockFetch(fakeService());
    const [c] = await loadActiveCyclones();
    expect(c.name).toBe('Lala');
    expect(c.id).toBe('cp012026');
    expect(c.basin).toBe('CP');
    expect(c.advisory).toBe('14');
    expect(c.observedTrack).toHaveLength(1);
    expect(c.forecastTrack).toHaveLength(1);
    expect(c.cone).toHaveLength(1);
  });

  it('orders fixes in time and reports the latest observed one as current', async () => {
    mockFetch(fakeService());
    const [c] = await loadActiveCyclones();
    expect(c.observed.map((f) => f.windKt)).toEqual([55, 65]);
    expect(c.forecast.map((f) => f.windKt)).toEqual([65, 50]);
    expect(c.current?.windKt).toBe(65);
    expect(c.peakForecastKt).toBe(65);
    // Forecast validity is the advisory time plus the forecast hour.
    expect(c.forecast[1].timeMs).toBe(10_000 + 12 * 3600_000);
  });

  it('borrows heading and speed from the advisory, without editing the best track', async () => {
    mockFetch(fakeService());
    const [c] = await loadActiveCyclones();
    // The best-track fix has the position and intensity; only the advisory publishes movement.
    expect(c.current?.headingDeg).toBe(305);
    expect(c.current?.speedKt).toBe(7);
    expect(c.current?.gustKt).toBe(80);
    expect(c.observed[c.observed.length - 1].headingDeg).toBeNull();
  });

  it('reads 9999 as missing rather than as a reading', async () => {
    mockFetch(fakeService());
    const [c] = await loadActiveCyclones();
    const later = c.forecast[1];
    expect(later.pressureMb).toBeNull();
    expect(later.headingDeg).toBeNull();
    expect(later.speedKt).toBeNull();
    expect(c.forecast[0].headingDeg).toBe(305);
  });

  it('keeps only the four alert codes it can color', async () => {
    mockFetch(fakeService());
    const [c] = await loadActiveCyclones();
    expect(c.alerts).toHaveLength(1);
    expect(c.alerts[0].code).toBe('HWR');
  });

  it('still returns a usable storm when individual layers fail', async () => {
    const bodies = fakeService();
    bodies[4] = new Error('cone layer down');
    bodies[5] = new Error('alerts layer down');
    mockFetch(bodies);
    const [c] = await loadActiveCyclones();
    expect(c.cone).toEqual([]);
    expect(c.alerts).toEqual([]);
    expect(c.current?.windKt).toBe(65);
  });

  it('throws when nothing is reachable, so "no storms" cannot be faked by an outage', async () => {
    mockFetch(Array.from({ length: 6 }, () => new Error('offline')));
    await expect(loadActiveCyclones()).rejects.toThrow('offline');
  });

  it('returns an empty list when the service reports no active storms', async () => {
    mockFetch(Array.from({ length: 6 }, () => ({ features: [] })));
    expect(await loadActiveCyclones()).toEqual([]);
  });
});

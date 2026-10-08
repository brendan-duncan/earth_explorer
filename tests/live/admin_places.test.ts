import { describe, it, expect, vi, afterEach } from 'vitest';
import { detailForZoom, placeRankForZoom, formatPopulation } from '../../src/live/admin_places.js';

describe('the detail ladder', () => {
  it('climbs scales as the view narrows', () => {
    expect(detailForZoom(1)).toBe('110m');
    expect(detailForZoom(2.9)).toBe('110m');
    expect(detailForZoom(3)).toBe('50m');
    expect(detailForZoom(11.9)).toBe('50m');
    expect(detailForZoom(12)).toBe('10m');
    expect(detailForZoom(500)).toBe('10m');
  });

  it('admits one more rank of city per doubling, and stops at the last rank', () => {
    expect(placeRankForZoom(1)).toBe(1);
    expect(placeRankForZoom(4)).toBe(3);
    expect(placeRankForZoom(64)).toBe(7);
    expect(placeRankForZoom(10_000)).toBe(10);
    // Monotonic: zooming in must never REMOVE a label that was already earned.
    let prev = 0;
    for (let z = 1; z < 200; z *= 1.3) {
      const rank = placeRankForZoom(z);
      expect(rank).toBeGreaterThanOrEqual(prev);
      prev = rank;
    }
  });
});

describe('formatPopulation', () => {
  it('reads the way a label should', () => {
    expect(formatPopulation(8_600_000)).toBe('8.6M');
    expect(formatPopulation(21_000_000)).toBe('21M');
    expect(formatPopulation(340_000)).toBe('340k');
    expect(formatPopulation(4200)).toBe('4,200');
    expect(formatPopulation(null)).toBe('');
  });
});

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

const LINE = (props: object): object =>
  ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } });
const CITY = (name: string, rank: number, pop: number, capital = 0): object => ({
  type: 'Feature',
  properties: { name, scalerank: rank, pop_max: pop, adm0cap: capital, adm0name: 'Testland' },
  geometry: { type: 'Point', coordinates: [1, 2] },
});

/**
 * A pristine copy of the module. The level caches live at module scope and are never invalidated
 * — that is the point of them — so a test that wants to observe a FETCH has to start from a module
 * that has not already served that level.
 */
async function freshModule(): Promise<typeof import('../../src/live/admin_places.js')> {
  vi.resetModules();
  return import('../../src/live/admin_places.js');
}

describe('loadBoundaryLines', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('requests the level asked for, and substitutes 50m states at 10m', async () => {
    const { loadBoundaryLines } = await freshModule();
    const fn = mockFetch([{ features: [LINE({})] }, { features: [LINE({})] }]);
    await loadBoundaryLines('10m');
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('ne_10m_admin_0_boundary_lines_land');
    // 1:10M state lines are past jsDelivr's file ceiling, so that level falls back by design.
    expect(urls[1]).toContain('ne_50m_admin_1_states_provinces_lines');
  });

  it('still yields country lines when the state file fails', async () => {
    const { loadBoundaryLines } = await freshModule();
    mockFetch([{ features: [LINE({})] }, new Error('404')]);
    const lines = await loadBoundaryLines('50m');
    expect(lines.country).toHaveLength(1);
    expect(lines.state).toEqual([]);
  });

  it('caches a level so zooming back out is not a refetch', async () => {
    const { loadBoundaryLines } = await freshModule();
    const fn = mockFetch([{ features: [LINE({})] }, { features: [LINE({})] }]);
    await loadBoundaryLines('110m');
    await loadBoundaryLines('110m');
    expect(fn).toHaveBeenCalledTimes(2);   // two files, once — not four calls
  });

  it('throws when both files fail, so an outage is not drawn as an empty world', async () => {
    const { loadBoundaryLines } = await freshModule();
    mockFetch([new Error('offline'), new Error('offline')]);
    await expect(loadBoundaryLines('50m')).rejects.toThrow();
  });

  it('lets a failed level be retried rather than caching the failure', async () => {
    const { loadBoundaryLines } = await freshModule();
    mockFetch([new Error('offline'), new Error('offline')]);
    await expect(loadBoundaryLines('50m')).rejects.toThrow();
    mockFetch([{ features: [LINE({})] }, { features: [LINE({})] }]);
    expect((await loadBoundaryLines('50m')).country).toHaveLength(1);
  });
});

describe('loadPlaces', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sorts by prominence, with capitals promoted half a rank', async () => {
    const { loadPlaces } = await freshModule();
    mockFetch([{ features: [
      CITY('Bigtown', 2, 5_000_000),
      CITY('Capitalia', 2, 400_000, 1),
      CITY('Hamlet', 8, 900),
    ] }]);
    const places = await loadPlaces('50m');
    expect(places.map((p) => p.name)).toEqual(['Capitalia', 'Bigtown', 'Hamlet']);
    expect(places[0].capital).toBe(true);
    expect(places[2].population).toBe(900);
  });

  it('drops entries with no name or no position', async () => {
    const { loadPlaces } = await freshModule();
    mockFetch([{ features: [
      CITY('Real', 1, 100),
      { type: 'Feature', properties: { name: '' }, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: { name: 'Ghost' }, geometry: null },
    ] }]);
    expect((await loadPlaces('110m')).map((p) => p.name)).toEqual(['Real']);
  });
});

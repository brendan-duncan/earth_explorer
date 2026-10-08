import { describe, it, expect } from 'vitest';
import { FD_EXTENT, geosProject } from '../../src/live/geostationary.js';

describe('geosProject (ABI fixed grid, inverse)', () => {
  it('maps the sub-satellite point to the disk center', () => {
    const p = geosProject(-75.2, 0, -75.2)!;
    expect(p.x).toBeCloseTo(0, 8);
    expect(p.y).toBeCloseTo(0, 8);
  });

  it('is antisymmetric east/west of the sub-satellite longitude', () => {
    const e = geosProject(-65.2, 0, -75.2)!;
    const w = geosProject(-85.2, 0, -75.2)!;
    expect(e.x).toBeCloseTo(-w.x, 10);
    expect(e.x).toBeGreaterThan(0);   // east of nadir = +x scan angle
    expect(e.y).toBeCloseTo(0, 10);
  });

  it('puts north at +y', () => {
    const n = geosProject(-75.2, 45, -75.2)!;
    expect(n.y).toBeGreaterThan(0);
    expect(n.x).toBeCloseTo(0, 10);
  });

  it('stays inside the full-disk image extent for visible points', () => {
    for (const [lon, lat] of [[-75.2, 0], [-140, 30], [-10, -40], [-75.2, 75]] as const) {
      const p = geosProject(lon, lat, -75.2);
      expect(p).not.toBeNull();
      expect(Math.hypot(p!.x, p!.y)).toBeLessThanOrEqual(FD_EXTENT);
    }
  });

  it('rejects points beyond the limb', () => {
    expect(geosProject(105, 0, -75.2)).toBeNull();       // antipodal side
    expect(geosProject(-75.2, 89.9, -75.2)).toBeNull();  // over the pole
    expect(geosProject(20, 10, -75.2)).toBeNull();       // ~95° of longitude away
  });

  it('handles the antimeridian wrap for Pacific satellites', () => {
    // 170°E is 53° WEST of GOES-West (137°W) across the date line — visible, at a −x scan angle.
    const p = geosProject(170, 0, -137.0);
    expect(p).not.toBeNull();
    expect(p!.x).toBeLessThan(0);
  });
});

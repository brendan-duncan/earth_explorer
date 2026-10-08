import { describe, it, expect } from 'vitest';
import { subsolarPoint } from '../../src/live/sun.js';

describe('subsolarPoint', () => {
  it('puts the June solstice sun near the Tropic of Cancer at Greenwich noon', () => {
    const p = subsolarPoint(Date.UTC(2026, 5, 21, 12));
    expect(p.latDeg).toBeGreaterThan(23.0);
    expect(p.latDeg).toBeLessThan(23.7);
    expect(Math.abs(p.lonDeg)).toBeLessThan(2.5);   // ± equation of time
  });

  it('puts the December solstice sun near the Tropic of Capricorn', () => {
    const p = subsolarPoint(Date.UTC(2026, 11, 21, 12));
    expect(p.latDeg).toBeLessThan(-23.0);
    expect(p.latDeg).toBeGreaterThan(-23.7);
  });

  it('crosses the equator at the March equinox', () => {
    const p = subsolarPoint(Date.UTC(2026, 2, 20, 12));
    expect(Math.abs(p.latDeg)).toBeLessThan(0.7);
  });

  it('sits near the antimeridian at Greenwich midnight', () => {
    const p = subsolarPoint(Date.UTC(2026, 5, 21, 0));
    expect(Math.abs(Math.abs(p.lonDeg) - 180)).toBeLessThan(2.5);
  });

  it('moves west ~15° per hour', () => {
    const a = subsolarPoint(Date.UTC(2026, 3, 10, 14));
    const b = subsolarPoint(Date.UTC(2026, 3, 10, 15));
    const d = ((a.lonDeg - b.lonDeg) % 360 + 360) % 360;
    expect(d).toBeGreaterThan(14.5);
    expect(d).toBeLessThan(15.5);
  });
});

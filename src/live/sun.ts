/**
 * Low-precision solar ephemeris — the subsolar point (where the sun is straight overhead) for a
 * given instant. Standard mean-elements formulas (Astronomical Almanac approximation), good to
 * ~0.01° over the current century: plenty for a day/night terminator.
 * @category Live
 */

/** The subsolar longitude/latitude (degrees, lon in −180..180) at `epochMs`. @category Live */
export function subsolarPoint(epochMs: number): { lonDeg: number; latDeg: number } {
  const d = (epochMs - Date.UTC(2000, 0, 1, 12)) / 86400e3;   // days since J2000.0
  const rad = Math.PI / 180;
  const g = (357.529 + 0.98560028 * d) * rad;                                   // mean anomaly
  const q = 280.459 + 0.98564736 * d;                                           // mean longitude (deg)
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;          // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * rad;                                    // obliquity
  const latDeg = Math.asin(Math.sin(e) * Math.sin(L)) / rad;                    // declination
  const raDeg = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;       // right ascension
  const gmstDeg = 280.46061837 + 360.98564736629 * d;                           // Greenwich sidereal
  const lonDeg = ((raDeg - gmstDeg) % 360 + 540) % 360 - 180;
  return { lonDeg, latDeg };
}

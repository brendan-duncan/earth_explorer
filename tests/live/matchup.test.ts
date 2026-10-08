import { describe, it, expect } from 'vitest';
import {
  matchupStations, matchupSummary, matchupTable, parseStationCsv, StationParseError,
  type MatchupFrame, type Station,
} from '../../src/live/matchup.js';

/** A frame whose value is a pure function of position, so a test can assert the sampled number. */
function frame(date: string, f: (lon: number, lat: number) => number | null): MatchupFrame {
  return { date, sample: (lon, lat) => f(lon, lat) };
}

describe('parseStationCsv', () => {
  it('reads a plain lon/lat file and reports which headers it used', () => {
    const p = parseStationCsv('longitude,latitude\n-158.0,21.3\n-157.5,21.0\n');
    expect(p.stations).toHaveLength(2);
    expect(p.stations[0]).toMatchObject({ lon: -158, lat: 21.3, id: 'row-2' });
    expect(p.matched).toMatchObject({ lon: 'longitude', lat: 'latitude' });
  });

  it('accepts Darwin Core headers, so an OBIS/GBIF export drops straight in', () => {
    const p = parseStationCsv('occurrenceID,decimalLatitude,decimalLongitude,eventDate\nabc,21.3,-158.0,2024-06-15\n');
    expect(p.stations[0]).toMatchObject({ lon: -158, lat: 21.3 });
    expect(p.matched.time).toBe('eventDate');
    expect(p.stations[0].time).toBe(Date.parse('2024-06-15T12:00:00Z'));
  });

  it('picks up an id column and short lat/lon aliases', () => {
    const p = parseStationCsv('station,lat,lon\nMooring-A,10,20\n');
    expect(p.stations[0].id).toBe('Mooring-A');
    expect(p.matched.id).toBe('station');
  });

  it('detects tab and semicolon delimiters', () => {
    expect(parseStationCsv('lon\tlat\n1\t2\n').delimiter).toBe('tab');
    expect(parseStationCsv('lon;lat\n1;2\n').delimiter).toBe(';');
  });

  it('honours quoted fields, including commas and doubled quotes inside them', () => {
    const p = parseStationCsv('name,lon,lat\n"Reef ""A"", north",-158.0,21.3\n');
    expect(p.stations[0].id).toBe('Reef "A", north');
    expect(p.stations[0].lon).toBe(-158);
  });

  it('folds a 0-360 longitude file into the -180..180 the samplers use', () => {
    const p = parseStationCsv('lon,lat\n200,10\n350,-5\n');
    expect(p.stations[0].lon).toBe(-160);
    expect(p.stations[1].lon).toBe(-10);
  });

  it('drops bad rows with a REASON rather than silently — a typo must not become missing data', () => {
    const p = parseStationCsv('lon,lat\n-158,21.3\n,21.4\n-158,not-a-number\n-158,95\n');
    expect(p.stations).toHaveLength(1);
    expect(p.skipped).toHaveLength(3);
    expect(p.skipped[0].line).toBe(3);
    expect(p.skipped[2].reason).toMatch(/outside −90..90|swapped/);
  });

  it('keeps a station whose TIME is unreadable, and says the time was ignored', () => {
    const p = parseStationCsv('lon,lat,date\n-158,21.3,last tuesday\n');
    expect(p.stations).toHaveLength(1);
    expect(p.stations[0].time).toBeUndefined();
    expect(p.skipped[0].reason).toMatch(/ignored its time/);
  });

  it('refuses a file with no recognisable coordinates instead of guessing', () => {
    expect(() => parseStationCsv('a,b\n1,2\n')).toThrow(StationParseError);
    expect(() => parseStationCsv('a,b\n1,2\n')).toThrow(/no longitude\/latitude columns/);
  });

  it('refuses an empty or header-only file', () => {
    expect(() => parseStationCsv('lon,lat\n')).toThrow(/no data rows/);
  });

  it('refuses a file where every row is unusable', () => {
    expect(() => parseStationCsv('lon,lat\n,\nx,y\n')).toThrow(/no usable stations/);
  });
});

describe('matchupStations', () => {
  const st = (id: string, lon: number, lat: number, time?: string): Station =>
    ({ id, lon, lat, line: 1, ...(time ? { time: Date.parse(time) } : {}) });

  const frames = [
    frame('2024-01-15', () => 1),
    frame('2024-02-15', () => 2),
    frame('2024-03-15', () => 3),
  ];

  it('picks the frame nearest the station time and reports the signed lag', () => {
    const rows = matchupStations([st('a', 0, 0, '2024-02-10T00:00:00Z')], frames);
    expect(rows[0].matchedDate).toBe('2024-02-15');
    expect(rows[0].value).toBe(2);
    expect(rows[0].lagDays).toBeCloseTo(5.5, 1);   // frame is LATER than the sample
    expect(rows[0].status).toBe('ok');
  });

  it('refuses a match beyond the tolerance rather than pairing distant dates', () => {
    // A June sample against a record that stops in March is not a match-up.
    const rows = matchupStations([st('a', 0, 0, '2024-06-01T00:00:00Z')], frames, { maxLagDays: 16 });
    expect(rows[0].status).toBe('no-frame');
    expect(rows[0].matchedDate).toBeNull();
    expect(rows[0].value).toBeNull();
  });

  it('uses the last frame for stations with no time of their own', () => {
    const rows = matchupStations([st('a', 0, 0)], frames);
    expect(rows[0].matchedDate).toBe('2024-03-15');
    expect(rows[0].lagDays).toBeNull();
  });

  it('honours an explicit fallback frame for untimed stations', () => {
    const rows = matchupStations([st('a', 0, 0)], frames, { fallbackDate: '2024-01-15' });
    expect(rows[0].matchedDate).toBe('2024-01-15');
    expect(rows[0].value).toBe(1);
  });

  it('distinguishes NO-DATA from NO-FRAME — they call for different responses', () => {
    // The record covers this date; the product simply has a hole here (land, cloud, ice).
    const holed = [frame('2024-02-15', (lon) => (lon < 0 ? null : 5))];
    const rows = matchupStations(
      [st('ocean', 10, 0, '2024-02-15T00:00:00Z'), st('land', -10, 0, '2024-02-15T00:00:00Z')], holed);
    expect(rows[0].status).toBe('ok');
    expect(rows[1].status).toBe('no-data');
    expect(rows[1].matchedDate).toBe('2024-02-15');   // a frame WAS found; it had no value
  });

  it('treats a NaN sample as no-data, not as a number', () => {
    const rows = matchupStations([st('a', 0, 0)], [frame('2024-01-01', () => NaN)]);
    expect(rows[0].status).toBe('no-data');
    expect(rows[0].value).toBeNull();
  });

  it('reports every station as no-frame when there is no record at all', () => {
    const rows = matchupStations([st('a', 0, 0), st('b', 1, 1)], []);
    expect(rows.every((r) => r.status === 'no-frame')).toBe(true);
  });

  it('samples at the station position, not the frame centre', () => {
    const rows = matchupStations([st('a', -158, 21.3)], [frame('2024-01-01', (lon, lat) => lon + lat)]);
    expect(rows[0].value).toBeCloseTo(-136.7, 6);
  });
});

describe('matchupTable / matchupSummary', () => {
  const rows = matchupStations(
    [
      { id: 's1', lon: 10, lat: 0, line: 2, time: Date.parse('2024-02-15T00:00:00Z') },
      { id: 's2', lon: -10, lat: 0, line: 3, time: Date.parse('2024-02-15T00:00:00Z') },
      { id: 's3', lon: 0, lat: 0, line: 4, time: Date.parse('2030-01-01T00:00:00Z') },
    ],
    [frame('2024-02-15', (lon) => (lon < 0 ? null : 7))],
  );

  it('exports one row per station with the outcome spelled out', () => {
    const t = matchupTable(rows, 'sst_degC');
    expect(t.header).toContain('sst_degC');
    expect(t.header).toContain('status');
    expect(t.rows).toHaveLength(3);
    // Lag is +0.5 d, not 0: a bare `YYYY-MM-DD` frame pins to 12:00Z and the station is at 00:00Z.
    expect(t.rows[0]).toEqual(['s1', 10, 0, '2024-02-15T00:00:00.000Z', '2024-02-15', 0.5, 7, 'ok']);
    expect(t.rows[1][6]).toBe('');            // no-data leaves the value blank…
    expect(t.rows[1][7]).toBe('no-data');     // …and says why
    expect(t.rows[2][7]).toBe('no-frame');
  });

  it('counts the three outcomes for the summary line', () => {
    expect(matchupSummary(rows)).toEqual({ ok: 1, noData: 1, noFrame: 1, total: 3 });
  });
});

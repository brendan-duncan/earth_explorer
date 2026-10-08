import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ensoEvents, eventAt, mergeEnsoMonths, monthsFromDays, oniSeasons, parseBakedEnso, strengthLabel,
  type EnsoBakedJson, type EnsoMonth,
} from '../../src/live/enso.js';

/** Contiguous months from `start` (`YYYY-MM`) with the given anomalies. */
function run(start: string, anoms: number[]): EnsoMonth[] {
  let y = parseInt(start.slice(0, 4), 10);
  let m = parseInt(start.slice(5, 7), 10) - 1;
  return anoms.map((anom) => {
    const month = `${y}-${String(m + 1).padStart(2, '0')}`;
    m++;
    y += Math.floor(m / 12);
    m %= 12;
    return { month, anom, samples: 6 };
  });
}

describe('oniSeasons', () => {
  it('is the centered 3-month running mean, labeled by center month', () => {
    const s = oniSeasons(run('2000-01', [0.3, 0.6, 0.9, 1.2]));
    expect(s.map((x) => x.month)).toEqual(['2000-02', '2000-03']);
    expect(s[0].oni).toBeCloseTo((0.3 + 0.6 + 0.9) / 3, 10);
    expect(s[1].oni).toBeCloseTo((0.6 + 0.9 + 1.2) / 3, 10);
  });

  it('never averages across a gap in the record', () => {
    const months = [...run('2000-01', [1, 1, 1]), ...run('2000-06', [1, 1, 1])];
    expect(oniSeasons(months).map((s) => s.month)).toEqual(['2000-02', '2000-07']);
  });
});

describe('ensoEvents', () => {
  it('classifies ≥5 consecutive qualifying seasons as an event, with the signed peak', () => {
    // 7 warm months → 5 seasons ≥ 0.5 (centered means of a plateau shaped 0.8..1.4..0.8).
    const months = run('2010-01', [0, 0.8, 1.0, 1.2, 1.4, 1.2, 1.0, 0.8, 0]);
    const ev = ensoEvents(oniSeasons(months));
    expect(ev).toHaveLength(1);
    expect(ev[0].phase).toBe('el-nino');
    expect(ev[0].peak).toBeGreaterThanOrEqual(1.2);
    expect(ev[0].start < ev[0].end).toBe(true);
  });

  it('leaves a 4-season excursion neutral', () => {
    // 4 warm months bracketed by neutral → exactly 4 qualifying seasons (Feb..May), one short.
    const months = run('2010-01', [0, 0.9, 0.9, 0.9, 0.9, 0]);
    const qualifying = oniSeasons(months).filter((s) => s.oni >= 0.5);
    expect(qualifying).toHaveLength(4);
    expect(ensoEvents(oniSeasons(months))).toHaveLength(0);
  });

  it('classifies cool runs as la-nina with a negative peak', () => {
    const months = run('2020-06', [0, -0.8, -1.0, -1.1, -1.2, -1.1, -1.0, -0.8, 0]);
    const ev = ensoEvents(oniSeasons(months));
    expect(ev).toHaveLength(1);
    expect(ev[0].phase).toBe('la-nina');
    expect(ev[0].peak).toBeLessThan(-1);
  });

  it('eventAt finds the containing event by month', () => {
    const months = run('2010-01', [0, 0.8, 1.0, 1.2, 1.4, 1.2, 1.0, 0.8, 0]);
    const ev = ensoEvents(oniSeasons(months));
    expect(eventAt(ev, '2010-05')?.phase).toBe('el-nino');
    expect(eventAt(ev, '2009-01')).toBeNull();
  });
});

describe('strengthLabel', () => {
  it('follows the conventional bins', () => {
    expect(strengthLabel(0.6)).toBe('weak');
    expect(strengthLabel(-1.2)).toBe('moderate');
    expect(strengthLabel(1.7)).toBe('strong');
    expect(strengthLabel(-2.4)).toBe('very strong');
  });
});

describe('monthsFromDays / mergeEnsoMonths', () => {
  it('bins per-day box means into calendar months', () => {
    const days = new Map<string, number>([
      ['2024-01-05', 1.0], ['2024-01-15', 2.0], ['2024-02-10', -1.0],
    ]);
    const months = monthsFromDays(days);
    expect(months).toEqual([
      { month: '2024-01', anom: 1.5, samples: 2 },
      { month: '2024-02', anom: -1.0, samples: 1 },
    ]);
  });

  it('live months override baked ones on merge', () => {
    const baked = run('2024-01', [1, 2]);
    const live: EnsoMonth[] = [{ month: '2024-02', anom: 9, samples: 3 }, { month: '2024-03', anom: 4, samples: 3 }];
    const merged = mergeEnsoMonths(baked, live);
    expect(merged.map((m) => [m.month, m.anom])).toEqual([['2024-01', 1], ['2024-02', 9], ['2024-03', 4]]);
  });
});

describe('baked Niño 3.4 record (assets/geo/enso_nino34.json)', () => {
  const j = JSON.parse(readFileSync(resolve(__dirname, '../../assets/geo/enso_nino34.json'), 'utf8')) as EnsoBakedJson;
  const months = parseBakedEnso(j);
  const seasons = oniSeasons(months);
  const events = ensoEvents(seasons);

  it('spans the OISST era contiguously enough to classify', () => {
    expect(months[0].month <= '1981-09').toBe(true);
    expect(months.length).toBeGreaterThan(500);
    expect(seasons.length).toBeGreaterThan(490);
  });

  it('detects the textbook events with the right phase and strength', () => {
    const at = (m: string): ReturnType<typeof eventAt> => eventAt(events, m);
    // 1997–98 and 2015–16: the two "very strong" El Niños of the record.
    expect(at('1997-12')?.phase).toBe('el-nino');
    expect(Math.abs(at('1997-12')!.peak)).toBeGreaterThan(1.8);
    expect(at('2015-12')?.phase).toBe('el-nino');
    expect(Math.abs(at('2015-12')!.peak)).toBeGreaterThan(1.8);
    // 2023–24 El Niño.
    expect(at('2023-12')?.phase).toBe('el-nino');
    // 2010–11 and the 2020–23 triple-dip La Niñas.
    expect(at('2010-12')?.phase).toBe('la-nina');
    expect(at('2021-01')?.phase).toBe('la-nina');
    expect(at('2022-07')?.phase).toBe('la-nina');
    // A famously neutral stretch.
    expect(at('2013-06')).toBeNull();
  });
});

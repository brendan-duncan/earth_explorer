import { describe, it, expect } from 'vitest';
import {
  correlationPValue, effectiveSampleSize, incompleteBeta, lag1Autocorrelation,
  studentTTwoSided, trendFit,
} from '../../src/analysis/stats.js';

describe('incompleteBeta', () => {
  it('is symmetric about the half and pinned at the ends', () => {
    expect(incompleteBeta(2, 2, 0)).toBe(0);
    expect(incompleteBeta(2, 2, 1)).toBe(1);
    expect(incompleteBeta(3, 3, 0.5)).toBeCloseTo(0.5, 10);
    expect(incompleteBeta(2, 5, 0.3) + incompleteBeta(5, 2, 0.7)).toBeCloseTo(1, 10);
  });

  it('matches the closed form for integer a with b = 1 (I_x(a,1) = x^a)', () => {
    expect(incompleteBeta(3, 1, 0.4)).toBeCloseTo(0.4 ** 3, 10);
    expect(incompleteBeta(7, 1, 0.9)).toBeCloseTo(0.9 ** 7, 10);
  });
});

describe('studentTTwoSided', () => {
  // Reference values from the standard t table (two-sided).
  it('reproduces textbook critical values', () => {
    expect(studentTTwoSided(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(studentTTwoSided(3.169, 10)).toBeCloseTo(0.01, 3);
    expect(studentTTwoSided(1.960, 1e7)).toBeCloseTo(0.05, 3);   // → normal in the limit
    expect(studentTTwoSided(2.086, 20)).toBeCloseTo(0.05, 3);
  });

  it('t = 0 is certainly not significant, and p falls as t grows', () => {
    expect(studentTTwoSided(0, 10)).toBeCloseTo(1, 10);
    expect(studentTTwoSided(5, 10)).toBeLessThan(studentTTwoSided(2, 10));
    expect(studentTTwoSided(-3, 10)).toBeCloseTo(studentTTwoSided(3, 10), 12);
  });

  it('returns NaN rather than a verdict when there are no degrees of freedom', () => {
    expect(studentTTwoSided(2, 0)).toBeNaN();
    expect(studentTTwoSided(NaN, 10)).toBeNaN();
  });
});

describe('lag1Autocorrelation', () => {
  it('is ≈1 for a monotone ramp and ≈−1 for an alternating sequence', () => {
    const ramp = Array.from({ length: 50 }, (_, i) => i);
    expect(lag1Autocorrelation(ramp)).toBeGreaterThan(0.9);
    const flip = Array.from({ length: 50 }, (_, i) => (i % 2 ? 1 : -1));
    expect(lag1Autocorrelation(flip)).toBeLessThan(-0.9);
  });

  it('breaks the pair across a gap instead of bridging it', () => {
    // Without the gap these would be two consecutive equal values contributing positive covariance.
    const withGap = [1, -1, NaN, 1, -1, 1, -1, 1, -1];
    expect(lag1Autocorrelation(withGap)).toBeLessThan(0);
  });

  it('needs at least three samples', () => {
    expect(lag1Autocorrelation([1, 2])).toBeNaN();
  });
});

describe('effectiveSampleSize', () => {
  it('discounts persistent series and never claims more samples than were measured', () => {
    // Bretherton: n(1 − r1a·r1b)/(1 + r1a·r1b). r1 = 0.5 both sides → 100·0.75/1.25 = 60.
    expect(effectiveSampleSize(100, 0.5, 0.5)).toBeCloseTo(60, 6);
    expect(effectiveSampleSize(100, 0, 0)).toBeCloseTo(100, 6);
    // Anticorrelated residuals would formally give n_eff > n; that is not a claim we make.
    expect(effectiveSampleSize(100, -0.5, 0.5)).toBe(100);
  });

  it('floors at 2 so a degenerate case cannot produce negative degrees of freedom', () => {
    expect(effectiveSampleSize(3, 0.99, 0.99)).toBeGreaterThanOrEqual(2);
  });
});

describe('correlationPValue', () => {
  it('agrees with the t-test on the effective sample size', () => {
    // r = 0.5, n_eff = 20 → t = 0.5·sqrt(18/0.75) = 2.449 on 18 df.
    expect(correlationPValue(0.5, 20)).toBeCloseTo(studentTTwoSided(2.4495, 18), 4);
  });

  it('is the whole point of the effective sample size: the SAME r can flip verdict', () => {
    // An r that clears 0.05 on 40 raw pairs fails once persistence halves the independent samples.
    expect(correlationPValue(0.32, 40)).toBeLessThan(0.05);
    expect(correlationPValue(0.32, 16)).toBeGreaterThan(0.05);
  });

  it('has no verdict without degrees of freedom', () => {
    expect(correlationPValue(0.9, 2)).toBeNaN();
    expect(correlationPValue(NaN, 30)).toBeNaN();
  });
});

describe('trendFit', () => {
  it('recovers a known slope and calls a clean line significant', () => {
    const xs = Array.from({ length: 30 }, (_, i) => i);
    const ys = xs.map((x) => 3 + 2 * x);
    const fit = trendFit(xs, ys);
    expect(fit.slope).toBeCloseTo(2, 9);
    expect(fit.intercept).toBeCloseTo(3, 9);
    expect(fit.n).toBe(30);
    expect(fit.p).toBeLessThan(0.001);
  });

  it('reports a standard error that scales with the noise', () => {
    const xs = Array.from({ length: 60 }, (_, i) => i);
    // Deterministic pseudo-noise: same shape, ten times the amplitude.
    const noise = (i: number, amp: number): number => amp * Math.sin(i * 2.399963);
    const quiet = trendFit(xs, xs.map((x, i) => 2 * x + noise(i, 0.1)));
    const loud = trendFit(xs, xs.map((x, i) => 2 * x + noise(i, 1.0)));
    expect(quiet.slope).toBeCloseTo(2, 2);
    expect(loud.slope).toBeCloseTo(2, 1);
    expect(loud.stderr).toBeGreaterThan(quiet.stderr * 5);
  });

  it('discounts the sample size when the residuals are serially correlated', () => {
    const xs = Array.from({ length: 80 }, (_, i) => i);
    // A slow wave around a flat line: residuals are strongly persistent, so n_eff ≪ n.
    const ys = xs.map((x) => Math.sin(x / 12));
    const fit = trendFit(xs, ys);
    expect(fit.r1).toBeGreaterThan(0.8);
    expect(fit.nEff).toBeLessThan(fit.n / 2);
  });

  it('skips non-finite pairs rather than poisoning the fit', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const ys = [0, 2, NaN, 6, 8, 10, 12, NaN, 16, 18];
    const fit = trendFit(xs, ys);
    expect(fit.slope).toBeCloseTo(2, 9);
    expect(fit.n).toBe(8);
  });

  it('has no fit at all below three points', () => {
    expect(trendFit([0, 1], [0, 1]).slope).toBeNaN();
  });
});

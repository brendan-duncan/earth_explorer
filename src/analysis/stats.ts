/**
 * Significance testing for the geo analysis graph.
 *
 * Geophysical time series are serially correlated: consecutive monthly SST values are not
 * independent draws, so the textbook `df = n − 2` badly overstates the evidence behind a
 * trend or a correlation. Every test here therefore runs on an EFFECTIVE sample size that
 * discounts n by the lag-1 autocorrelation — the standard climate-literature correction
 * (Bretherton et al. 1999 for correlations; Santer et al. 2000 for trends).
 *
 * Pure numerics: no DOM, no GPU, no fetch, so this runs unchanged inside the analysis Worker.
 *
 * @category Analysis
 */

/** Lanczos log Γ(x), x > 0. */
function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction evaluation of the incomplete beta function (Lentz's method). */
function betacf(a: number, b: number, x: number): number {
  const MAX_ITER = 300;
  const EPS = 3e-14;
  const TINY = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) {
    d = TINY;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) {
      break;
    }
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). @category Analysis */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (!(x > 0)) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/**
 * Two-sided p-value of Student's t with `df` degrees of freedom — the probability of seeing
 * a statistic at least this extreme when the true effect is zero. NaN for df < 1 or a
 * non-finite statistic, so an untestable cell stays visibly untested rather than reading as
 * "not significant".
 * @category Analysis
 */
export function studentTTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t) || !(df >= 1)) {
    return NaN;
  }
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

/**
 * Discounts a raw sample count by serial correlation: `n_eff = n · (1 − r1a·r1b) / (1 + r1a·r1b)`.
 * For a trend test both arguments are the residual lag-1 autocorrelation; for a correlation they
 * are the two inputs' lag-1 autocorrelations (Bretherton et al. 1999).
 *
 * Clamped to `[2, n]`: negative lag-1 correlation would otherwise claim MORE independent samples
 * than were actually measured, which is not a claim this code should make.
 * @category Analysis
 */
export function effectiveSampleSize(n: number, r1a: number, r1b: number): number {
  const ra = Number.isFinite(r1a) ? Math.max(-0.99, Math.min(0.99, r1a)) : 0;
  const rb = Number.isFinite(r1b) ? Math.max(-0.99, Math.min(0.99, r1b)) : 0;
  const rho = ra * rb;
  const nEff = (n * (1 - rho)) / (1 + rho);
  return Math.max(2, Math.min(n, nEff));
}

/**
 * Two-sided p-value for a Pearson r given an effective sample size.
 * `t = r · sqrt((n_eff − 2) / (1 − r²))` on `n_eff − 2` degrees of freedom.
 * @category Analysis
 */
export function correlationPValue(r: number, nEff: number): number {
  if (!Number.isFinite(r) || !(nEff > 2)) {
    return NaN;
  }
  const rr = Math.min(0.999999999, Math.abs(r));
  const df = nEff - 2;
  const t = rr * Math.sqrt(df / (1 - rr * rr));
  return studentTTwoSided(t, df);
}

/**
 * Lag-1 autocorrelation of `xs` about its own mean, over CONSECUTIVE valid pairs only.
 * A gap in the series breaks the pair rather than silently bridging across it.
 * @category Analysis
 */
export function lag1Autocorrelation(xs: ArrayLike<number>): number {
  let sum = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i])) {
      sum += xs[i]; n++;
    }
  }
  if (n < 3) {
    return NaN;
  }
  const mean = sum / n;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i];
    if (!Number.isFinite(a)) {
      continue;
    }
    den += (a - mean) * (a - mean);
    const b = xs[i + 1];
    if (i + 1 < xs.length && Number.isFinite(b)) {
      num += (a - mean) * (b - mean);
    }
  }
  return den > 0 ? num / den : NaN;
}

/** A least-squares fit with the uncertainty needed to test it. @category Analysis */
export interface TrendFit {
  /** Slope in y-units per x-unit. */
  slope: number;
  intercept: number;
  /** Standard error of the slope, computed on the effective (not raw) sample size. */
  stderr: number;
  /** Two-sided p-value against "the slope is zero". */
  p: number;
  /** Raw samples behind the fit. */
  n: number;
  /** Samples after the residual-autocorrelation discount. */
  nEff: number;
  /** Lag-1 autocorrelation of the residuals. */
  r1: number;
}

/**
 * Ordinary least squares plus a Santer-style significance test: the slope's standard error uses
 * the residual variance spread over `n_eff − 2` degrees of freedom, where `n_eff` discounts the
 * sample count by the residuals' lag-1 autocorrelation. Non-finite pairs are skipped.
 *
 * Returns NaN statistics (rather than throwing) when there is nothing to fit, so a per-cell caller
 * can run this over a whole grid without branching.
 * @category Analysis
 */
export function trendFit(xs: ArrayLike<number>, ys: ArrayLike<number>): TrendFit {
  const nan: TrendFit = { slope: NaN, intercept: NaN, stderr: NaN, p: NaN, n: 0, nEff: 0, r1: NaN };
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
  }
  if (n < 3) {
    return { ...nan, n };
  }
  const sxxC = sxx - (sx * sx) / n;
  if (!(sxxC > 0)) {
    return { ...nan, n };
  }
  const slope = (sxy - (sx * sy) / n) / sxxC;
  const intercept = (sy - slope * sx) / n;
  // Residuals in time order, so their lag-1 autocorrelation is meaningful; a skipped pair leaves a
  // NaN so lag1Autocorrelation breaks the pair there instead of bridging the gap.
  const resid = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    resid[i] = Number.isFinite(x) && Number.isFinite(y) ? y - (intercept + slope * x) : NaN;
  }
  const r1 = lag1Autocorrelation(resid);
  const nEff = effectiveSampleSize(n, r1, r1);
  const stats = slopeStats(resid, sxxC, nEff, slope);
  return { slope, intercept, ...stats, n, nEff, r1 };
}

/** Slope standard error + p from residuals, an effective sample size and the centered Σ(x−x̄)². */
function slopeStats(resid: ArrayLike<number>, sxxCentered: number, nEff: number, slope: number): { stderr: number; p: number } {
  let sse = 0;
  for (let i = 0; i < resid.length; i++) {
    if (Number.isFinite(resid[i])) {
      sse += resid[i] * resid[i];
    }
  }
  const df = nEff - 2;
  if (!(df >= 1)) {
    return { stderr: NaN, p: NaN };
  }
  const stderr = Math.sqrt(sse / df / sxxCentered);
  if (!(stderr > 0)) {
    // A perfect fit (zero residual) is significant unless the slope itself is zero.
    return { stderr: 0, p: slope === 0 ? 1 : 0 };
  }
  return { stderr, p: studentTTwoSided(slope / stderr, df) };
}

/**
 * The same fit as {@link trendFit} but driven by pre-accumulated sums and a caller-supplied
 * residual pass — the form a per-cell grid loop needs, where materializing an `xs`/`ys` array per
 * cell would allocate 64 800 times per field.
 * @category Analysis
 */
export function trendFitFromSums(
  n: number, sxxCentered: number, slope: number, sse: number, residualR1: number,
): { stderr: number; p: number; nEff: number } {
  if (n < 3 || !(sxxCentered > 0)) {
    return { stderr: NaN, p: NaN, nEff: n };
  }
  const nEff = effectiveSampleSize(n, residualR1, residualR1);
  const df = nEff - 2;
  if (!(df >= 1)) {
    return { stderr: NaN, p: NaN, nEff };
  }
  const stderr = Math.sqrt(sse / df / sxxCentered);
  if (!(stderr > 0)) {
    return { stderr: 0, p: slope === 0 ? 1 : 0, nEff };
  }
  return { stderr, p: studentTTwoSided(slope / stderr, df), nEff };
}

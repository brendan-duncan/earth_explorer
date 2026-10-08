/**
 * Scientific colormaps for false-color data layers (first used by the SST layer's study
 * view). One source of truth for both the GPU render path — a 256×1 LUT texture the water
 * shader samples by normalized temperature — and the HTML legend/colorbar, which evaluates
 * the same stops so the two never drift.
 *
 * Each colormap is a short list of `[t, r, g, b]` control points (t in 0..1, channels in
 * 0..255) linearly interpolated. The defaults are perceptually reasonable, colorblind-
 * friendlier choices plus the two oceanographers expect (a blue→red "thermal" and grayscale).
 *
 * @category Live
 */

import { Texture } from '../gpu/texture.js';

/** A colormap control point: position `t` in [0,1] and 8-bit RGB. */
type Stop = readonly [number, number, number, number];

/** The available colormap names. @category Live */
export type SstColormapName = 'turbo' | 'thermal' | 'viridis' | 'cividis' | 'grayscale' | 'balance' | 'ice' | 'chl';

/** Ordered list of selectable colormaps (name + human label), for building a UI picker.
 *  @category Live */
export const SST_COLORMAPS: ReadonlyArray<{ name: SstColormapName; label: string }> = [
  { name: 'thermal', label: 'Thermal (blue→red)' },
  { name: 'viridis', label: 'Viridis' },
  { name: 'cividis', label: 'Cividis (CVD-safe)' },
  { name: 'balance', label: 'Balance (diverging)' },
  { name: 'ice', label: 'Ice' },
  { name: 'chl', label: 'Ocean color' },
  { name: 'grayscale', label: 'Grayscale' },
  { name: 'turbo', label: 'Turbo (avoid — see ⓘ)' },
];

const STOPS: Record<SstColormapName, readonly Stop[]> = {
  /**
   * Google "Turbo" — vivid and high dynamic range, but the WORST ramp here for reading values.
   *
   * Its lightness is not monotonic (dark at both ends, brilliant in the middle), so it invents
   * boundaries the data does not have, and under simulated protanopia two readings an eighth of the
   * scale apart come within ΔE ≈ 5 of each other — they stop being distinguishable at all. Kept
   * because existing links and saved views reference it; no layer defaults to it any more.
   */
  turbo: [
    [0.00, 48, 18, 59], [0.13, 65, 105, 225], [0.25, 30, 175, 220],
    [0.40, 40, 210, 150], [0.55, 150, 230, 55], [0.70, 240, 200, 40],
    [0.85, 245, 110, 30], [1.00, 165, 20, 10],
  ],
  // Classic oceanographic thermal: cold deep blue → warm red.
  thermal: [
    [0.00, 8, 24, 90], [0.25, 20, 110, 200], [0.50, 40, 200, 190],
    [0.70, 235, 220, 90], [0.85, 235, 130, 40], [1.00, 170, 20, 25],
  ],
  // Matplotlib Viridis (perceptually uniform, colorblind-friendly).
  viridis: [
    [0.00, 68, 1, 84], [0.25, 59, 82, 139], [0.50, 33, 145, 140],
    [0.75, 94, 201, 98], [1.00, 253, 231, 37],
  ],
  /**
   * Cividis — built for color-vision deficiency: monotonic in lightness and very nearly IDENTICAL
   * to a dichromat and to someone with normal vision, which no hue-varying ramp can claim. Under
   * the same simulation that breaks turbo, its normal / deuteranope / protanope renderings differ
   * by under ΔE 0.3. The default for sequential intensity layers.
   */
  cividis: [
    [0.00, 0, 32, 76], [0.25, 44, 73, 109], [0.50, 101, 110, 111],
    [0.75, 159, 152, 89], [1.00, 255, 233, 69],
  ],
  grayscale: [
    [0.00, 10, 12, 18], [1.00, 245, 248, 252],
  ],
  // Diverging blue→white→red for anomalies (cold below normal, warm above); white at the center.
  balance: [
    [0.00, 20, 60, 150], [0.25, 60, 130, 210], [0.48, 205, 225, 240],
    [0.52, 245, 225, 205], [0.75, 225, 110, 70], [1.00, 150, 20, 30],
  ],
  // Sea ice: open water deep blue → thin ice cyan → solid pack ice white.
  ice: [
    [0.00, 6, 26, 60], [0.35, 20, 90, 150], [0.7, 130, 200, 225], [1.00, 248, 250, 255],
  ],
  // Chlorophyll / ocean color: NASA-style high-contrast log ramp — near-black oligotrophic blue
  // through cyan/green to bloom yellow and eutrophic orange-red, so gyres read dark and
  // productive water pops.
  chl: [
    [0.00, 5, 8, 45], [0.18, 15, 45, 130], [0.36, 0, 115, 175], [0.52, 20, 175, 130],
    [0.68, 120, 205, 60], [0.84, 235, 220, 40], [1.00, 250, 110, 25],
  ],
};

/** Sample a colormap at `t` (clamped to [0,1]); returns 8-bit `[r, g, b]`. @category Live */
export function sampleSstColormap(name: SstColormapName, t: number): [number, number, number] {
  const stops = STOPS[name] ?? STOPS.turbo;
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const span = b[0] - a[0];
      const u = span > 1e-6 ? (x - a[0]) / span : 0;
      return [
        Math.round(a[1] + (b[1] - a[1]) * u),
        Math.round(a[2] + (b[2] - a[2]) * u),
        Math.round(a[3] + (b[3] - a[3]) * u),
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

/** A CSS `linear-gradient(...)` string for the legend/colorbar (left = cold, right = warm).
 *  @category Live */
export function sstColormapCssGradient(name: SstColormapName, steps = 16): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [r, g, b] = sampleSstColormap(name, t);
    parts.push(`rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Builds a 256×1 rgba8 LUT texture for `name`, sampled in the shader by normalized value.
 *  Uses clamp-to-edge and linear filtering (bind an appropriate sampler). @category Live */
export function buildSstColormapLut(device: GPUDevice, name: SstColormapName): Texture {
  const W = 256;
  const data = new Uint8Array(W * 4);
  for (let i = 0; i < W; i++) {
    const [r, g, b] = sampleSstColormap(name, i / (W - 1));
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  const tex = device.createTexture({
    label: `SstColormapLut:${name}`, size: { width: W, height: 1 }, format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: W * 4, rowsPerImage: 1 }, { width: W, height: 1 });
  return new Texture(tex, '2d');
}

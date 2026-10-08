// Animated GPU particle-trail overlay for a vector field (ocean currents / wind), used by
// geo_gis_explorer.ts. Particles live in equirectangular uv space and are advected by a (u,v)
// value-texture in a compute pass; their trails accumulate into an EQUIRECT trail texture that
// fades a little each frame. The sample's main shader samples that trail texture by uv — so the
// flow composites identically in the flat map and on the rotating globe (trails rotate with it),
// with no screen-space bookkeeping and no per-projection particle re-projection.
//
// The trail raster and the particle population cover a WINDOW of that uv space (the whole world by
// default, the visible rect when zoomed in), for the same reason the sample's annotation rasters
// do. A world-sized trail buffer spends its texels uniformly over the planet: zoomed to a storm,
// the few hundred visible texels of a 2048-wide raster arrive on screen as soft magnified smears,
// and the handful of particles that happen to be inside the view are all the flow there is. Both
// problems are the same problem — density fixed in WORLD space instead of screen space — and both
// are fixed by advecting and stamping in window-local uv, which puts every particle and every
// texel where the user is looking. See `setWindow`.

import { Texture } from './gpu/texture.js';
import type { GriddedField } from './live/gridded_field.js';

const ADVECT = /* wgsl */ `
struct AU {
  dt : f32, time : f32, speedScale : f32, life : f32,
  uMax : f32, count : f32, blend : f32, _p1 : f32,
  win : vec4<f32>,   // window rect in world uv: u0, v0, spanU, spanV (whole world = 0,0,1,1)
};
@group(0) @binding(0) var<storage, read_write> parts : array<vec4<f32>>;  // xy = WINDOW-local uv, z = age, w = seed
@group(0) @binding(1) var fieldA : texture_2d<f32>;
@group(0) @binding(2) var fsamp : sampler;
@group(0) @binding(3) var<uniform> au : AU;
@group(0) @binding(4) var fieldB : texture_2d<f32>;   // next dated frame (interpolation target)

fn hash(n : f32) -> f32 { return fract(sin(n * 12.9898) * 43758.5453); }

/** Window-local uv (the space particles and the trail raster live in) → world equirect uv. */
fn toWorld(local : vec2<f32>, win : vec4<f32>) -> vec2<f32> {
  return vec2<f32>(fract(win.x + local.x * win.z), win.y + local.y * win.w);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= u32(au.count)) { return; }
  var p = parts[i];
  let uv = toWorld(p.xy, au.win);
  // Interpolate the vector field between the two straddling dated frames so currents evolve smoothly.
  let s = mix(textureSampleLevel(fieldA, fsamp, uv, 0.0), textureSampleLevel(fieldB, fsamp, uv, 0.0), au.blend);
  let vel = (s.rg - vec2<f32>(0.5)) * 2.0 * au.uMax;    // m/s
  let lat = (0.5 - uv.y) * 180.0;
  let cosl = max(cos(radians(lat)), 0.2);
  // Step in WORLD uv, then convert into the window's own space. Dividing by the span alone is the
  // geographically exact conversion and is unusable: the same 20 m/s crosses a 4°-wide window ~90×
  // faster than it crosses the globe, so a zoomed-in view becomes a strobing white mat — 90× the
  // speed is also 90× the trail length, and the ink goes up with it. Multiplying back by the span
  // holds the APPARENT screen speed constant instead, so trail length, ink density and motion look
  // the same at every zoom and only the detail changes. The scale is a scalar, so direction is
  // untouched, and within one view trail length still ranks fast wind against slow.
  let step = vec2<f32>(vel.x / cosl, -vel.y) * au.speedScale * au.dt;   // +v = north = -uv.y
  var nl = p.xy + vec2<f32>(step.x / au.win.z, step.y / au.win.w) * au.win.z;
  p.z += au.dt;
  // Left the window? Respawn. Only the whole-world case wraps in u — there the window IS the
  // planet, so a particle crossing the antimeridian must come back on the other side rather than
  // die and leave a bald seam down the map.
  let wraps = au.win.z > 0.999;
  if (wraps) {
    nl.x = fract(nl.x);
  }
  let outside = nl.x < 0.0 || nl.x > 1.0 || nl.y < 0.0 || nl.y > 1.0;
  let dead = s.a < 0.5 || p.z > au.life || length(vel) < 0.02 || outside;
  if (dead) {
    let seed = p.w;
    nl = vec2<f32>(hash(seed + au.time), hash(seed * 1.7 + au.time * 0.37));
    p.z = hash(seed * 3.1) * au.life;                  // stagger initial ages so respawns don't pulse
    p.w = seed + 1.37;
  }
  p.x = select(clamp(nl.x, 0.0, 1.0), fract(nl.x), wraps);
  p.y = clamp(nl.y, 0.0, 1.0);
  parts[i] = p;
}
`;

const DRAW = /* wgsl */ `
struct DU { trailW : f32, trailH : f32, pointSize : f32, _p : f32, tint : vec4<f32>, win : vec4<f32> };
@group(0) @binding(0) var<storage, read> parts : array<vec4<f32>>;
@group(0) @binding(1) var<uniform> du : DU;
@group(0) @binding(2) var field : texture_2d<f32>;
@group(0) @binding(3) var fsamp : sampler;

struct VO { @builtin(position) pos : vec4<f32>, @location(0) local : vec2<f32>, @location(1) col : vec3<f32> };

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VO {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let q = quad[vi];
  let p = parts[ii];
  // Particles are already in the trail raster's own space; only the field lookup needs world uv.
  let local = p.xy;
  let uv = vec2<f32>(fract(du.win.x + local.x * du.win.z), du.win.y + local.y * du.win.w);
  let px = local * vec2<f32>(du.trailW, du.trailH) + q * du.pointSize;
  var clip = px / vec2<f32>(du.trailW, du.trailH) * 2.0 - 1.0;
  clip.y = -clip.y;
  let s = textureSampleLevel(field, fsamp, uv, 0.0);
  var o : VO;
  o.pos = vec4<f32>(clip, 0.0, 1.0);
  o.local = q;
  // Neutral speed-driven intensity, fully colored by the per-overlay tint so the hue survives
  // additive blending over any base layer (currents read blue, wind pale). Kept dim so trails
  // read as thin streamlines, not speckle.
  o.col = vec3<f32>(0.12 + 0.6 * s.b) * du.tint.rgb;
  return o;
}

@fragment
fn fs(i : VO) -> @location(0) vec4<f32> {
  let a = smoothstep(1.0, 0.15, length(i.local));      // soft round dot
  return vec4<f32>(i.col * a, a);
}
`;

const FADE = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, FADE_RATE); }
`;

/** A rect of world equirect uv. `u0` may fall outside [0,1]; the shaders wrap it. */
export interface FlowWindow { u0: number; v0: number; du: number; dv: number }

/** The whole planet — the default, and what the overlay falls back to when zoomed out. */
export const FLOW_WORLD: FlowWindow = { u0: 0, v0: 0, du: 1, dv: 1 };

export interface FlowOverlayOpts {
  count?: number;        // particle count
  trailWidth?: number;   // equirect trail texture width (height = width/2)
  speedScale?: number;   // uv per (m/s·s) — visual advection speed
  life?: number;         // particle lifetime (s) before respawn
  pointSize?: number;    // trail dot radius, px
  fadeRate?: number;     // per-frame trail decay (0..1)
  tint?: [number, number, number];   // trail color multiplier (currents blue, wind pale)
}

/** One vector layer's particle system + fading equirect trail texture. */
export class FlowOverlay {
  private readonly count: number;
  private readonly trailW: number;
  private readonly trailH: number;
  private readonly speedScale: number;
  private readonly life: number;
  private readonly parts: GPUBuffer;
  private readonly advectU: GPUBuffer;
  private readonly drawU: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly advectPipe: GPUComputePipeline;
  private readonly drawPipe: GPURenderPipeline;
  private readonly fadePipe: GPURenderPipeline;
  private readonly trail: Texture;
  private advectBG: GPUBindGroup | null = null;
  private drawBG: GPUBindGroup | null = null;
  private field: GriddedField | null = null;
  private fieldB: GriddedField | null = null;
  private uMax = 1;
  private cleared = false;
  private win: FlowWindow = FLOW_WORLD;
  private readonly tint: [number, number, number];
  private readonly pointSize: number;

  constructor(private readonly device: GPUDevice, opts: FlowOverlayOpts = {}) {
    this.count = opts.count ?? 16000;
    this.trailW = opts.trailWidth ?? 1024;
    this.trailH = this.trailW / 2;
    this.speedScale = opts.speedScale ?? 0.01;
    this.life = opts.life ?? 3.5;
    this.pointSize = opts.pointSize ?? 1.4;
    const fadeRate = opts.fadeRate ?? 0.045;

    // Particles seeded at random uv (age staggered) so the field fills in immediately.
    const init = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      init[i * 4] = Math.random();
      init[i * 4 + 1] = Math.random();
      init[i * 4 + 2] = Math.random() * this.life;
      init[i * 4 + 3] = i * 1.618;
    }
    this.parts = device.createBuffer({ size: init.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.parts, 0, init.buffer as ArrayBuffer);

    this.tint = opts.tint ?? [1, 1, 1];
    this.advectU = device.createBuffer({ size: 12 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.drawU = device.createBuffer({ size: 12 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.writeDrawUniform();

    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });

    const trailTex = device.createTexture({
      label: 'FlowTrail', size: { width: this.trailW, height: this.trailH }, format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    this.trail = new Texture(trailTex, '2d');

    this.advectPipe = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: ADVECT }), entryPoint: 'main' },
    });
    this.drawPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code: DRAW }), entryPoint: 'vs' },
      fragment: {
        module: device.createShaderModule({ code: DRAW }), entryPoint: 'fs',
        targets: [{
          format: 'rgba8unorm',
          blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.fadePipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code: FADE.replace(/FADE_RATE/g, fadeRate.toFixed(4)) }), entryPoint: 'vs' },
      fragment: {
        module: device.createShaderModule({ code: FADE.replace(/FADE_RATE/g, fadeRate.toFixed(4)) }), entryPoint: 'fs',
        targets: [{
          format: 'rgba8unorm',
          blend: { color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' } },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private writeDrawUniform(): void {
    const du = new Float32Array([
      this.trailW, this.trailH, this.pointSize, 0,
      this.tint[0], this.tint[1], this.tint[2], 0,
      this.win.u0, this.win.v0, this.win.du, this.win.dv,
    ]);
    this.device.queue.writeBuffer(this.drawU, 0, du.buffer as ArrayBuffer);
  }

  /** The trail texture the main shader samples (rgb = additive flow color), in {@link window} space. */
  get trailView(): GPUTextureView {
    return this.trail.view;
  }

  /** The uv rect the trail raster currently covers — the caller must sample it through this. */
  get window(): FlowWindow {
    return this.win;
  }

  /**
   * Points the particles and their trail raster at a rect of the world.
   *
   * The trail texture keeps its size, so a smaller window is a proportionally finer raster, and
   * the fixed particle budget concentrates into it instead of being spread across a planet mostly
   * off screen. The accumulated trails are dropped on every change: they are a history of where
   * particles have been in the OLD frame of reference, and reinterpreting those texels under a new
   * rect would smear a wrong flow across the map for a second or two.
   */
  setWindow(w: FlowWindow): void {
    if (w.u0 === this.win.u0 && w.v0 === this.win.v0 && w.du === this.win.du && w.dv === this.win.dv) {
      return;
    }
    this.win = { ...w };
    this.writeDrawUniform();
    this.cleared = false;   // next update() clears rather than loads the stale trails
  }

  hasField(): boolean {
    return this.field !== null;
  }

  /** Swap in a single vector field (no interpolation). */
  setField(field: GriddedField): void {
    this.setFields(field, field);
  }

  /**
   * Set the two dated frames to advect between (advection samples `mix(a, b, blend)`, with `blend`
   * passed to {@link update}). Rebuilds bind groups only when a texture actually changes.
   */
  setFields(a: GriddedField, b: GriddedField): void {
    if (this.field === a && this.fieldB === b) {
      return;
    }
    this.field = a;
    this.fieldB = b;
    this.uMax = a.meta.max;
    this.advectBG = this.device.createBindGroup({
      layout: this.advectPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.parts } },
        { binding: 1, resource: a.texture.view },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.advectU } },
        { binding: 4, resource: b.texture.view },
      ],
    });
    this.drawBG = this.device.createBindGroup({
      layout: this.drawPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.parts } },
        { binding: 1, resource: { buffer: this.drawU } },
        { binding: 2, resource: a.texture.view },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  /** Advance the particles and stamp their trails (blend = interpolation between the two frames). */
  update(encoder: GPUCommandEncoder, dt: number, time: number, blend = 0): void {
    if (!this.field || !this.advectBG || !this.drawBG) {
      return;
    }
    const au = new Float32Array([
      Math.min(dt, 0.05), time, this.speedScale, this.life,
      this.uMax, this.count, blend, 0,
      this.win.u0, this.win.v0, this.win.du, this.win.dv,
    ]);
    this.device.queue.writeBuffer(this.advectU, 0, au.buffer as ArrayBuffer);

    const cpass = encoder.beginComputePass();
    cpass.setPipeline(this.advectPipe);
    cpass.setBindGroup(0, this.advectBG);
    cpass.dispatchWorkgroups(Math.ceil(this.count / 64));
    cpass.end();

    const rpass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.trail.view,
        loadOp: this.cleared ? 'load' : 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    this.cleared = true;
    rpass.setPipeline(this.fadePipe);
    rpass.draw(3);
    rpass.setPipeline(this.drawPipe);
    rpass.setBindGroup(0, this.drawBG);
    rpass.draw(6, this.count);
    rpass.end();
  }
}

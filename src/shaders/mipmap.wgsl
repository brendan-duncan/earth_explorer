// Mip-chain downsample. Renders a fullscreen triangle that samples the previous
// mip level with a linear filter — at exact half-resolution that is a 2x2 box
// average. Used by `generateMipmaps` in assets/texture.ts.

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0)       uv : vec2<f32>,
}

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
  let x = f32((vid & 1u) << 2u) - 1.0;
  let y = f32((vid & 2u) << 1u) - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv  = vec2<f32>(x * 0.5 + 0.5, -y * 0.5 + 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(src, samp, in.uv, 0.0);
}

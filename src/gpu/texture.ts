import mipmapWgsl from '../shaders/mipmap.wgsl?raw';

/**
 * Texture view dimensionality supported by the engine.
 * @category Assets
 */
export type TextureType = '2d' | '3d' | 'cube' | '2d-array';

/**
 * Bytes per 4×4 block for the block-compressed formats {@link Texture.fromCompressed}
 * accepts (the KTX2/Basis transcode targets). Formats absent here (e.g.
 * `rgba8unorm`) are treated as uncompressed `width×4` rows.
 */
const COMPRESSED_BLOCK_BYTES: Partial<Record<GPUTextureFormat, number>> = {
  'bc1-rgba-unorm': 8,  'bc1-rgba-unorm-srgb': 8,
  'bc3-rgba-unorm': 16, 'bc3-rgba-unorm-srgb': 16,
  'bc7-rgba-unorm': 16, 'bc7-rgba-unorm-srgb': 16,
  'etc2-rgba8unorm': 16, 'etc2-rgba8unorm-srgb': 16,
  'astc-4x4-unorm': 16, 'astc-4x4-unorm-srgb': 16,
};

// Mip-generation pipeline is format-dependent (sRGB vs linear render target);
// cache one per device per format. The downsample sampler is device-global.
const _mipPipelines = new WeakMap<GPUDevice, Map<GPUTextureFormat, GPURenderPipeline>>();
const _mipSamplers  = new WeakMap<GPUDevice, GPUSampler>();

/** Per-target-mip downsample resources, cached by texture + array layer (see
 *  `generateMipmaps`). */
interface MipChain {
  /** Render target view for each mip level (index = mip; index 0 unused). */
  targetViews: GPUTextureView[];
  /** Bind group sampling mip-1 for each target mip (index = mip; index 0 unused). */
  bindGroups: GPUBindGroup[];
}
// generateMipmaps runs every frame on the same pooled textures (e.g. the
// transmission snapshot). Creating per-mip views + bind groups each call is the
// dominant per-frame GPU-object churn, so cache them by texture (and by array
// layer for 2d-array textures). Auto-evicted when the texture is GC'd /
// destroyed.
const _mipChains = new WeakMap<GPUTexture, Map<number, MipChain>>();

function _mipPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  let byFormat = _mipPipelines.get(device);
  if (!byFormat) {
    byFormat = new Map();
    _mipPipelines.set(device, byFormat);
  }
  let pipeline = byFormat.get(format);
  if (!pipeline) {
    const module = device.createShaderModule({ code: mipmapWgsl, label: 'MipmapShader' });
    pipeline = device.createRenderPipeline({
      label: 'MipmapPipeline',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    byFormat.set(format, pipeline);
  }
  return pipeline;
}

function _mipSampler(device: GPUDevice): GPUSampler {
  let sampler = _mipSamplers.get(device);
  if (!sampler) {
    sampler = device.createSampler({ label: 'MipmapSampler', magFilter: 'linear', minFilter: 'linear' });
    _mipSamplers.set(device, sampler);
  }
  return sampler;
}

/**
 * Fills mip levels `1..mipLevelCount-1` of `texture` by repeatedly
 * box-downsampling the previous level on the GPU. The texture must have been
 * created with `RENDER_ATTACHMENT` usage and the matching `mipLevelCount`, and
 * mip level 0 must already be populated.
 * @category Assets
 */
export function generateMipmaps(
  device: GPUDevice,
  texture: GPUTexture,
  format: GPUTextureFormat,
  mipLevelCount: number,
  /** When given, mip passes are recorded into this encoder and NOT submitted
   *  (so the caller controls ordering — e.g. inside a render-graph pass). */
  externalEncoder?: GPUCommandEncoder,
  /** For `2d-array` textures: the array layer to downsample (each layer needs
   *  its own call). Omit for plain 2d textures. */
  arrayLayer = 0,
): void {
  if (mipLevelCount <= 1) {
    return;
  }
  const pipeline = _mipPipeline(device, format);
  const sampler = _mipSampler(device);
  const encoder = externalEncoder ?? device.createCommandEncoder({ label: 'MipmapGen' });
  // Build (or reuse) the per-mip views + bind groups for this texture + layer.
  // They only depend on the texture identity, so caching them turns this from
  // per-frame object churn into a stable lookup.
  let byLayer = _mipChains.get(texture);
  if (!byLayer) {
    byLayer = new Map();
    _mipChains.set(texture, byLayer);
  }
  let chain = byLayer.get(arrayLayer);
  if (!chain || chain.bindGroups.length < mipLevelCount) {
    chain = { targetViews: [], bindGroups: [] };
    for (let mip = 1; mip < mipLevelCount; mip++) {
      chain.bindGroups[mip] = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({
            dimension: '2d', baseMipLevel: mip - 1, mipLevelCount: 1,
            baseArrayLayer: arrayLayer, arrayLayerCount: 1,
          }) },
          { binding: 1, resource: sampler },
        ],
      });
      chain.targetViews[mip] = texture.createView({
        dimension: '2d', baseMipLevel: mip, mipLevelCount: 1,
        baseArrayLayer: arrayLayer, arrayLayerCount: 1,
      });
    }
    byLayer.set(arrayLayer, chain);
  }
  for (let mip = 1; mip < mipLevelCount; mip++) {
    const pass = encoder.beginRenderPass({
      label: `Mipmap downsample mip${mip}`,
      colorAttachments: [{
        view: chain.targetViews[mip],
        loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, chain.bindGroups[mip]);
    pass.draw(3);
    pass.end();
  }
  if (!externalEncoder) {
    device.queue.submit([encoder.finish()]);
  }
}

/**
 * Owns a `GPUTexture` and a default `GPUTextureView` of the matching dimension.
 *
 * Callers must invoke `destroy()` to release the underlying GPU memory.
 * @category Assets
 */
export class Texture {
  readonly gpuTexture: GPUTexture;
  readonly view: GPUTextureView;
  readonly type: TextureType;

  /**
   * Wraps an existing `GPUTexture` and creates a default view with the matching dimension.
   *
   * @param gpuTexture - The GPU texture to take ownership of.
   * @param type - View dimensionality (2d, 3d, or cube).
   */
  constructor(gpuTexture: GPUTexture, type: TextureType) {
    this.gpuTexture = gpuTexture;
    this.type = type;
    this.view = gpuTexture.createView({
      dimension: type === 'cube' ? 'cube' : type === '3d' ? '3d' : type === '2d-array' ? '2d-array' : '2d',
    });
  }

  /** Destroys the underlying GPU texture. */
  destroy(): void { this.gpuTexture.destroy(); }

  /**
   * Creates a 1x1 `rgba8unorm` texture filled with the given color.
   *
   * @param device - The WebGPU device.
   * @param r - Red component, 0-255.
   * @param g - Green component, 0-255.
   * @param b - Blue component, 0-255.
   * @param a - Alpha component, 0-255 (defaults to 255).
   * @returns A new `Texture` owning the 1x1 GPU texture.
   */
  static createSolid(device: GPUDevice, r: number, g: number, b: number, a = 255): Texture {
    const tex = device.createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: tex },
      new Uint8Array([r, g, b, a]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    return new Texture(tex, '2d');
  }

  /**
   * Uploads an `ImageBitmap` as a 2D texture.
   *
   * @param device - The WebGPU device.
   * @param bitmap - Source image (typically from `createImageBitmap`).
   * @param options - `srgb=true` selects `rgba8unorm-srgb` so the GPU linearizes on sample; `usage` adds extra usage flags on top of the standard binding/copy/render set; `mipLevelCount>1` allocates a mip chain and box-downsamples it on the GPU after upload.
   * @returns A new `Texture` owning the uploaded 2D image.
   */
  static fromBitmap(device: GPUDevice, bitmap: ImageBitmap, { srgb = false, usage, mipLevelCount = 1 }: { srgb?: boolean; usage?: GPUTextureUsageFlags; mipLevelCount?: number } = {}): Texture {
    const format: GPUTextureFormat = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    usage = usage ? usage | (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT) : (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT);
    const tex = device.createTexture({
      size: { width: bitmap.width, height: bitmap.height },
      format,
      usage: usage,
      mipLevelCount,
    });
    device.queue.copyExternalImageToTexture(
      { source: bitmap, flipY: false },
      { texture: tex },
      { width: bitmap.width, height: bitmap.height },
    );
    if (mipLevelCount > 1) {
      generateMipmaps(device, tex, format, mipLevelCount);
    }
    return new Texture(tex, '2d');
  }

  /**
   * Uploads a pre-decoded (optionally block-compressed) 2D texture, one mip
   * level at a time. Used for KTX2/Basis textures transcoded by
   * `transcodeKtx2`: `levels[0]` is full resolution, each subsequent entry
   * a half-size mip. Block-compressed formats compute `bytesPerRow` from the 4×4
   * block size; `rgba8unorm[-srgb]` uses the uncompressed `width×4` stride.
   *
   * @param device - The WebGPU device.
   * @param data - `format` (GPU texture format), pixel `width`/`height`, and one byte array per mip `level`.
   * @returns A new `Texture` owning the uploaded image.
   */
  static fromCompressed(
    device: GPUDevice,
    data: { format: GPUTextureFormat; width: number; height: number; levels: Uint8Array<ArrayBuffer>[] },
  ): Texture {
    const { format, width, height, levels } = data;
    const blockBytes = COMPRESSED_BLOCK_BYTES[format]; // undefined => uncompressed rgba8
    const tex = device.createTexture({
      label: 'Texture fromCompressed',
      size: { width, height },
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      mipLevelCount: levels.length,
    });
    for (let level = 0; level < levels.length; level++) {
      const w = Math.max(1, width >> level);
      const h = Math.max(1, height >> level);
      const bytesPerRow = blockBytes ? Math.ceil(w / 4) * blockBytes : w * 4;
      const rowsPerImage = blockBytes ? Math.ceil(h / 4) : h;
      device.queue.writeTexture(
        { texture: tex, mipLevel: level },
        levels[level],
        { offset: 0, bytesPerRow, rowsPerImage },
        { width: w, height: h, depthOrArrayLayers: 1 },
      );
    }
    return new Texture(tex, '2d');
  }

  /**
   * Fetches an image URL and uploads it as a 2D GPU texture.
   *
   * Use `srgb=true` for albedo/color maps; keep `false` for normal/ORM maps.
   *
   * @param device - The WebGPU device.
   * @param url - URL to fetch the image from.
   * @param options - `srgb` enables `rgba8unorm-srgb`; `resizeWidth`/`resizeHeight` resize the bitmap before upload; `usage` adds extra usage flags (e.g. `COPY_SRC`); `generateMips` allocates and box-downsamples a full mip chain (needed so the texture minifies cleanly instead of aliasing at distance).
   * @returns A `Texture` containing the uploaded image.
   */
  static async fromUrl(device: GPUDevice, url: string, options: { srgb?: boolean; resizeWidth?: number; resizeHeight?: number; usage?: GPUTextureUsageFlags; generateMips?: boolean } = {}): Promise<Texture> {
    const blob = await (await fetch(url)).blob();
    const bitmapOptions: ImageBitmapOptions = { colorSpaceConversion: 'none' };
    if (options.resizeWidth !== undefined && options.resizeHeight !== undefined) {
      bitmapOptions.resizeWidth = options.resizeWidth;
      bitmapOptions.resizeHeight = options.resizeHeight;
      bitmapOptions.resizeQuality = 'high';
    }
    const bitmap = await createImageBitmap(blob, bitmapOptions);
    const mipLevelCount = options.generateMips
      ? 1 + Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height)))
      : 1;
    return Texture.fromBitmap(device, bitmap, { ...options, mipLevelCount });
  }
}

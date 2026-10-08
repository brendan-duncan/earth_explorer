/**
 * The explorer's WebGPU device + canvas swap chain.
 *
 * The map is a single fullscreen pass drawn straight to the canvas, so this is all the GPU setup it
 * needs: one device, an SDR swap chain in the preferred 8-bit format, and a per-frame
 * {@link GpuContext.update} that keeps the backing store matched to the canvas's CSS size.
 */

/** Cap on the device pixel ratio used to size the backing store, so DPR-3 phones don't render
 *  9× the pixels of a desktop for a map whose detail is set by its data grids. */
const MAX_PIXEL_RATIO = 1.2;

function pixelRatio(): number {
  return Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
}

export class GpuContext {
  private view: GPUTextureView | null = null;

  private constructor(
    readonly device: GPUDevice,
    readonly context: GPUCanvasContext,
    readonly format: GPUTextureFormat,
    readonly canvas: HTMLCanvasElement,
  ) {}

  /** Requests an adapter + device and configures `canvas` for presentation.
   *  @throws if WebGPU is unavailable or no adapter can be acquired. */
  static async create(canvas: HTMLCanvasElement): Promise<GpuContext> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter found');
    }
    // Ask for the adapter's maximum on the per-stage binding limits. Requesting a supported value
    // can never make requestDevice fail; it only permits larger bind groups than the defaults.
    const requiredLimits: Record<string, number> = {};
    for (const name of ['maxSampledTexturesPerShaderStage', 'maxStorageBuffersPerShaderStage'] as const) {
      const value = adapter.limits[name];
      if (typeof value === 'number' && value > 0) {
        requiredLimits[name] = value;
      }
    }
    const device = await adapter.requestDevice({ requiredLimits });
    device.addEventListener('uncapturederror', (event) => {
      const err = event.error;
      if (err instanceof GPUValidationError) {
        console.error('[WebGPU Validation Error]', err.message);
      } else if (err instanceof GPUOutOfMemoryError) {
        console.error('[WebGPU Out of Memory]');
      } else {
        console.error('[WebGPU Internal Error]', err);
      }
    });

    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const ctx = new GpuContext(device, context, format, canvas);
    ctx.update();
    return ctx;
  }

  /** Backing-store width in device pixels. */
  get width(): number {
    return this.canvas.width;
  }

  /** Backing-store height in device pixels. */
  get height(): number {
    return this.canvas.height;
  }

  /**
   * Call once per frame before drawing: resizes the backing store to the canvas's CSS size and
   * drops the cached swap-chain view so the next {@link backbufferView} reads this frame's texture.
   * @returns true when the canvas was resized.
   */
  update(): boolean {
    this.view = null;
    const dpr = pixelRatio();
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) {
      return false;
    }
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  /** View of the current frame's swap-chain texture. */
  get backbufferView(): GPUTextureView {
    if (!this.view) {
      this.view = this.context.getCurrentTexture().createView();
    }
    return this.view;
  }
}

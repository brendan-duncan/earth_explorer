// Polyfills for WebGPU globals that appear in module-level expressions in
// the renderer source (e.g. BufferDesc constants). Without these, importing
// any pass file in a Node test environment throws ReferenceError before the
// per-suite `beforeAll` hooks get a chance to run.
//
// Values mirror the canonical WebGPU bitflag layout; tests should not rely
// on any particular flag's numeric value beyond it being a finite integer.

(globalThis as any).GPUBufferUsage ??= {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
};

(globalThis as any).GPUTextureUsage ??= {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

(globalThis as any).GPUShaderStage ??= {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
};

(globalThis as any).GPUColorWrite ??= {
  RED: 0x1,
  GREEN: 0x2,
  BLUE: 0x4,
  ALPHA: 0x8,
  ALL: 0xF,
};

(globalThis as any).GPUMapMode ??= {
  READ: 0x1,
  WRITE: 0x2,
};

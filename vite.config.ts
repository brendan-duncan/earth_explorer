import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync, cpSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * LiteRT.js (the on-device ML forecast) loads its WebAssembly runtime at RUNTIME from a directory
 * URL — the loader picks among sibling `litert_wasm_*` variants by browser feature detection, so the
 * files must keep their names and layout and can't ride Vite's hashed `?url` imports. Expose
 * `node_modules/@litertjs/core/wasm/` at the stable path `assets/litert-wasm/`: a dev middleware
 * streams the files, and builds copy the directory.
 */
function litertWasmAssets(): Plugin {
  const wasmDir = resolve(rootDir, 'node_modules/@litertjs/core/wasm');
  const types: Record<string, string> = { '.wasm': 'application/wasm', '.js': 'text/javascript' };
  return {
    name: 'litert-wasm-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/\/assets\/litert-wasm\/([\w.-]+)(?:\?.*)?$/);
        if (!m) {
          return next();
        }
        const file = resolve(wasmDir, m[1]);
        if (!existsSync(file)) {
          return next();
        }
        res.setHeader('Content-Type', types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const dst = resolve(rootDir, 'dist/assets/litert-wasm');
      if (existsSync(wasmDir) && existsSync(resolve(rootDir, 'dist'))) {
        cpSync(wasmDir, dst, { recursive: true });
      }
    },
  };
}

/**
 * The user guide (`docs/guide/`, a self-contained static page) ships alongside the app at `guide/`,
 * so the Pages deploy serves it at `<site>/guide/`. It embeds the shared diagrams by `../illustrations/`,
 * so those ship at `illustrations/` beside it. A dev middleware maps both URL prefixes onto their
 * `docs/` directories, and builds copy them verbatim — hand-written HTML, not something Vite should bundle.
 */
function guideAssets(): Plugin {
  const dirs: Record<string, string> = {
    guide: resolve(rootDir, 'docs/guide'),
    illustrations: resolve(rootDir, 'docs/illustrations'),
  };
  const types: Record<string, string> = {
    '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  };
  return {
    name: 'guide-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/(guide|illustrations)(\/[^?]*)?(?:\?.*)?$/);
        if (!m) {
          return next();
        }
        if (!m[2]) {   // `/guide` → `/guide/`, so the page's relative paths resolve
          res.statusCode = 301;
          res.setHeader('Location', `/${m[1]}/`);
          return res.end();
        }
        const dir = dirs[m[1]];
        const file = resolve(dir, `.${m[2].endsWith('/') ? `${m[2]}index.html` : m[2]}`);
        if (!file.startsWith(dir) || !existsSync(file)) {
          return next();
        }
        res.setHeader('Content-Type', types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(resolve(rootDir, 'dist'))) {
        return;
      }
      for (const [name, dir] of Object.entries(dirs)) {
        if (existsSync(dir)) {
          cpSync(dir, resolve(rootDir, 'dist', name), { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so the build runs from any subdirectory of a static host.
  base: './',
  plugins: [litertWasmAssets(), guideAssets()],
  optimizeDeps: {
    // Behind a dynamic import (the forecast op), so the dependency scan doesn't see it up front.
    include: ['@litertjs/core'],
  },
  worker: {
    format: 'es',
  },
});

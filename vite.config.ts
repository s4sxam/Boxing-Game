import { defineConfig } from 'vite';

// SharedArrayBuffer (used for the zero-copy physics-worker <-> render-thread
// transform buffer) requires cross-origin isolation. Without these headers
// the browser silently disables SharedArrayBuffer and physics sync falls
// back to structured-clone postMessage (still correct, just slower/copies
// each frame) — see engine/physicsBridge.ts for the fallback path.
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});

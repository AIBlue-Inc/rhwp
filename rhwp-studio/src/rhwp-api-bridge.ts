/**
 * HTATIS bridge for rhwp-studio.
 *
 * Extends the existing `rhwp-request`/`rhwp-response` postMessage protocol
 * (see main.ts) with save-side methods: `exportHwp`, `exportHwpx`,
 * `subscribeChange`. Registers a second `message` listener — the original
 * handler in main.ts ignores unknown methods (its default branch replies
 * with an error, but that only fires if an `id` matches one of its cases;
 * since we use distinct method names, our responses win).
 *
 * Kept as a separate file to minimize upstream conflict surface.
 * Upstream PR candidate.
 */
import { wasm, eventBus } from './main';

const METHODS = new Set(['exportHwp', 'exportHwpx', 'subscribeChange']);

// Same-origin by default; extend if the host app lives on a different origin.
function isOriginAllowed(origin: string): boolean {
  if (origin === window.location.origin) return true;
  if (origin === 'null') return false; // sandboxed frames
  try {
    const u = new URL(origin);
    // Dev convenience: allow localhost on any port (Vite 3100, etc.)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  } catch {
    /* malformed origin */
  }
  return false;
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'rhwp-request' || typeof msg.method !== 'string') return;
  if (!METHODS.has(msg.method)) return; // let main.ts handle its own methods
  if (!isOriginAllowed(e.origin)) return;

  const { id, method } = msg as { id: number; method: string };
  const reply = (result?: unknown, error?: string) => {
    const source = e.source as Window | null;
    if (!source) return;
    source.postMessage(
      { type: 'rhwp-response', id, result, error },
      { targetOrigin: e.origin },
    );
  };

  try {
    switch (method) {
      case 'exportHwp': {
        const bytes = wasm.exportHwp() as Uint8Array;
        reply(Array.from(bytes));
        break;
      }
      case 'exportHwpx': {
        // Some rhwp versions may not implement hwpx export yet.
        const fn = (wasm as unknown as { exportHwpx?: () => Uint8Array })
          .exportHwpx;
        if (typeof fn !== 'function') {
          reply(undefined, 'exportHwpx not supported by this rhwp build');
          break;
        }
        reply(Array.from(fn.call(wasm)));
        break;
      }
      case 'subscribeChange': {
        const source = e.source as Window | null;
        if (!source) {
          reply(undefined, 'no source window');
          break;
        }
        const origin = e.origin;
        eventBus.on('document-changed', () => {
          try {
            source.postMessage(
              { type: 'rhwp-event', event: 'document-changed' },
              { targetOrigin: origin },
            );
          } catch {
            /* source closed */
          }
        });
        reply(true);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply(undefined, message);
  }
});

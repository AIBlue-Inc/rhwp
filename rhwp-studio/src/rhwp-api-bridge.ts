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

// Origin policy: same-origin only by default. Additional origins can be
// whitelisted at build time via a Vite define (e.g. VITE_RHWP_ALLOWED_ORIGINS
// as a comma-separated list). We intentionally do NOT auto-allow localhost
// ports in production — that was flagged in the Stage 1 codex review as a
// needless attack surface.
declare const __RHWP_EXTRA_ORIGINS__: string | undefined;

function loadAllowedOrigins(): Set<string> {
  const extra = typeof __RHWP_EXTRA_ORIGINS__ === 'string' ? __RHWP_EXTRA_ORIGINS__ : '';
  return new Set(
    [window.location.origin, ...extra.split(',').map((s) => s.trim())].filter(Boolean),
  );
}

const ALLOWED_ORIGINS = loadAllowedOrigins();

function isOriginAllowed(origin: string): boolean {
  if (origin === 'null') return false; // sandboxed frames
  return ALLOWED_ORIGINS.has(origin);
}

// Per-source subscription cleanup. Each window that calls `subscribeChange`
// gets exactly one listener; unsubscribe runs when the source is GC'd
// (detected lazily when postMessage fails) or when a second subscribe
// arrives from the same source (we treat it as an idempotent re-subscribe).
type Unsubscribe = () => void;
const subscriptions = new WeakMap<Window, Unsubscribe>();

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'rhwp-request' || typeof msg.method !== 'string') return;
  if (!METHODS.has(msg.method)) return; // let main.ts handle its own methods
  if (!isOriginAllowed(e.origin)) return;

  const { id, method } = msg as { id: number; method: string };
  const source = e.source as Window | null;
  const reply = (result?: unknown, error?: string) => {
    if (!source) return;
    try {
      source.postMessage(
        { type: 'rhwp-response', id, result, error },
        { targetOrigin: e.origin },
      );
    } catch {
      /* source closed */
    }
  };

  try {
    switch (method) {
      case 'exportHwp': {
        const bytes = wasm.exportHwp() as Uint8Array;
        reply(Array.from(bytes));
        break;
      }
      case 'exportHwpx': {
        const fn = (wasm as unknown as { exportHwpx?: () => Uint8Array }).exportHwpx;
        if (typeof fn !== 'function') {
          reply(undefined, 'exportHwpx not supported by this rhwp build');
          break;
        }
        reply(Array.from(fn.call(wasm)));
        break;
      }
      case 'subscribeChange': {
        if (!source) {
          reply(undefined, 'no source window');
          break;
        }
        // Idempotent: if this source already subscribed, drop the old one
        // before registering a new handler. Prevents duplicate events on
        // re-mount.
        subscriptions.get(source)?.();

        const origin = e.origin;
        const handler = () => {
          try {
            source.postMessage(
              { type: 'rhwp-event', event: 'document-changed' },
              { targetOrigin: origin },
            );
          } catch {
            // Source closed — clean up and stop notifying.
            subscriptions.get(source)?.();
            subscriptions.delete(source);
          }
        };
        const unsubscribe = eventBus.on('document-changed', handler) as Unsubscribe | void;
        // Fallback if EventBus.on does not return an unsubscribe function.
        const cleanup: Unsubscribe =
          typeof unsubscribe === 'function'
            ? unsubscribe
            : () => {
                const off = (eventBus as unknown as { off?: (ev: string, h: Function) => void })
                  .off;
                off?.call(eventBus, 'document-changed', handler);
              };
        subscriptions.set(source, cleanup);
        reply(true);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply(undefined, message);
  }
});

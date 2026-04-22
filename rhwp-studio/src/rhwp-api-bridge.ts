/**
 * HTATIS bridge for rhwp-studio.
 *
 * Sole `rhwp-request`/`rhwp-response` postMessage dispatcher. Absorbs the
 * legacy four methods (loadFile/pageCount/getPageSvg/ready) that used to
 * live in main.ts without origin checking, and adds cell-mutation / batch /
 * snapshot / readonly / highlight methods for the streaming AI-draft PoC.
 *
 * All methods are gated by the origin allowlist. No second listener exists.
 */
import { wasm, eventBus, initializeDocument, refreshDocumentView, getCanvasView } from './main';

const METHODS = new Set([
  // export + events (existing)
  'exportHwp', 'exportHwpx', 'subscribeChange',
  // migrated from main.ts legacy handler
  'loadFile', 'pageCount', 'getPageSvg', 'ready',
  // cell mutations (PoC)
  'insertTextInCell', 'deleteTextInCell', 'setFieldValueByName', 'replaceText',
  // explicit batching (PoC)
  'beginBatch', 'endBatch',
  // snapshots (PoC, name→id mapped internally)
  'saveSnapshot', 'restoreSnapshot', 'discardSnapshot',
  // studio-layer helpers (PoC)
  'setReadOnly', 'highlightCell', 'scrollToCell',
]);

declare const __RHWP_EXTRA_ORIGINS__: string | undefined;

function loadAllowedOrigins(): Set<string> {
  const extra = typeof __RHWP_EXTRA_ORIGINS__ === 'string' ? __RHWP_EXTRA_ORIGINS__ : '';
  return new Set(
    [window.location.origin, ...extra.split(',').map((s) => s.trim())].filter(Boolean),
  );
}

const ALLOWED_ORIGINS = loadAllowedOrigins();

function isOriginAllowed(origin: string): boolean {
  if (origin === 'null') return false;
  return ALLOWED_ORIGINS.has(origin);
}

// Per-source subscribeChange cleanup. See previous revision for rationale.
type Unsubscribe = () => void;
const subscriptions = new WeakMap<Window, Unsubscribe>();

// ─────────────────────────────────────────────────────────────
// Snapshot name → wasm id map. The WASM API is numeric-id based
// (saveSnapshot(): number); the postMessage protocol exposes a
// friendlier string-name interface for the PoC hook.
// ─────────────────────────────────────────────────────────────
const snapshotIds = new Map<string, number>();

// ─────────────────────────────────────────────────────────────
// Mutation queue + auto-batching.
//
// WASM is single-threaded so mutations must run serially. When a
// cell-mutation message arrives, we open an implicit batch (wasm
// beginBatch) and start an 80ms timer; subsequent mutations join
// the queue and the timer eventually drains them in one pass,
// collapsing rhwp repagination to a single cycle.
//
// An explicit beginBatch from the caller flushes the auto-timer,
// then keeps the batch open until the matching endBatch.
// ─────────────────────────────────────────────────────────────
const AUTO_BATCH_WINDOW_MS = 80;
let autoBatchOpen = false;
let explicitBatchOpen = false;
let autoBatchTimer: number | null = null;
let draining = false;

type MutationFn = () => unknown;
interface QueuedMutation {
  fn: MutationFn;
  reply: (result?: unknown, error?: string) => void;
}
const mutationQueue: QueuedMutation[] = [];

function rawDoc(): { beginBatch(): string; endBatch(): string } | null {
  // wasm-bridge.ts keeps the inner HwpDocument as `.doc` (private); we
  // access it via structural cast, matching the precedent at
  // wasm-bridge.ts:332-339 for insertTextInCellByPath et al.
  const d = (wasm as unknown as { doc?: unknown }).doc;
  return (d as { beginBatch(): string; endBatch(): string } | undefined) ?? null;
}

function beginBatchIfNeeded() {
  if (autoBatchOpen || explicitBatchOpen) return;
  try {
    rawDoc()?.beginBatch();
    autoBatchOpen = true;
  } catch (err) {
    console.error('[rhwp-bridge] beginBatch failed', err);
  }
}

function closeAutoBatchIfOpen() {
  if (!autoBatchOpen || explicitBatchOpen) return;
  try {
    rawDoc()?.endBatch();
  } catch (err) {
    console.error('[rhwp-bridge] endBatch failed', err);
  }
  autoBatchOpen = false;
  // Batch 종료 후 캔버스 재렌더 — cell-mutation 결과가 viewport 에 반영되도록.
  // refreshPages() 는 페이지 수/크기 재수집 + 보이는 페이지 재렌더를 수행한다.
  try {
    refreshDocumentView();
  } catch (err) {
    console.error('[rhwp-bridge] refreshDocumentView failed', err);
  }
  // subscribeChange 구독자(예: HwpEditor.onDocumentChanged) 에게 알림.
  try {
    eventBus.emit('document-changed');
  } catch (err) {
    console.error('[rhwp-bridge] eventBus.emit(document-changed) failed', err);
  }
}

function scheduleFlush() {
  if (autoBatchTimer !== null) return;
  autoBatchTimer = window.setTimeout(() => {
    autoBatchTimer = null;
    drain();
  }, AUTO_BATCH_WINDOW_MS);
}

function flushPendingNow() {
  if (autoBatchTimer !== null) {
    window.clearTimeout(autoBatchTimer);
    autoBatchTimer = null;
  }
  drain();
}

function drain() {
  if (draining) return;
  draining = true;
  try {
    while (mutationQueue.length) {
      const { fn, reply } = mutationQueue.shift()!;
      try {
        const r = fn();
        reply(r);
      } catch (err) {
        console.error('[rhwp-bridge] mutation failed', err);
        reply(undefined, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    draining = false;
    closeAutoBatchIfOpen();
  }
}

function enqueueMutation(fn: MutationFn, reply: (r?: unknown, e?: string) => void) {
  beginBatchIfNeeded();
  mutationQueue.push({ fn, reply });
  if (explicitBatchOpen) {
    // Explicit batch: caller will manage endBatch — run immediately,
    // still serially, no auto-timer.
    drain();
  } else {
    scheduleFlush();
  }
}

// ─────────────────────────────────────────────────────────────
// setReadOnly: full-viewport overlay inside the iframe document.
// Chosen over patching input-handler.ts to minimize upstream
// divergence. If keyboard events routed through `document` prove
// observable during PoC, we can add a keydown swallow on the
// overlay or promote to an input-handler guard flag.
// ─────────────────────────────────────────────────────────────
let readonlyOverlay: HTMLDivElement | null = null;

function setReadOnly(enabled: boolean): void {
  if (enabled) {
    if (readonlyOverlay) return;
    const overlay = document.createElement('div');
    overlay.setAttribute('data-htatis-readonly-overlay', '');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:9998',
      'background:rgba(255,255,255,0.02)',
      'cursor:not-allowed',
      'pointer-events:auto',
    ].join(';');
    const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
    overlay.addEventListener('mousedown', swallow, true);
    overlay.addEventListener('mouseup', swallow, true);
    overlay.addEventListener('click', swallow, true);
    overlay.addEventListener('dblclick', swallow, true);
    overlay.addEventListener('contextmenu', swallow, true);
    overlay.addEventListener('keydown', swallow, true);
    overlay.addEventListener('keyup', swallow, true);
    overlay.addEventListener('wheel', (e) => e.stopPropagation(), { capture: true, passive: true });
    document.body.appendChild(overlay);
    readonlyOverlay = overlay;
    (document.activeElement as HTMLElement | null)?.blur?.();
  } else {
    readonlyOverlay?.remove();
    readonlyOverlay = null;
  }
}

// ─────────────────────────────────────────────────────────────
// Cell bbox geometry — shared by highlightCell + scrollToCell.
//
// wasm.getTableCellBboxes(sec, para, ci) returns per-page bboxes
// ({pageIndex, x, y, w, h} in zoomed page-local px). We convert to
// scroll-container doc-space by:
//   docY = pageOffset[pageIndex] + y
//   docX = pageLeft[pageIndex] + x   (or margin-centered)
// using canvasView's VirtualScroll + Viewport zoom.
// ─────────────────────────────────────────────────────────────
interface CellBBox {
  cellIdx: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DocRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Resolve (sec, para, ci, cellIndex) → scroll-container doc-space rect. */
function getCellDocRect(
  sec: number,
  para: number,
  ci: number,
  cellIndex: number,
): DocRect | null {
  const cv = getCanvasView();
  if (!cv) return null;
  const vs = cv.getVirtualScroll();
  const vm = cv.getViewportManager();
  const zoom = vm?.getZoom?.() ?? 1.0;
  let bboxes: CellBBox[];
  try {
    // WasmBridge.getTableCellBboxes already parses the WASM JSON return
    // (see core/wasm-bridge.ts) — it hands back an array, not a string.
    bboxes = (wasm as unknown as {
      getTableCellBboxes: (s: number, p: number, c: number, ph?: number) => CellBBox[];
    }).getTableCellBboxes(sec, para, ci, 0);
  } catch (err) {
    console.warn('[rhwp-bridge] getTableCellBboxes failed', err);
    return null;
  }
  if (!Array.isArray(bboxes) || bboxes.length === 0) return null;
  const bbox = bboxes.find((b) => b.cellIdx === cellIndex) ?? bboxes[0];
  if (!bbox) return null;
  const pageOffset = vs.getPageOffset(bbox.pageIndex);
  const pageLeftRaw = vs.getPageLeft(bbox.pageIndex);
  const pageDisplayWidth = vs.getPageWidth(bbox.pageIndex);
  // getPageLeft returns -1 when using CSS centering; emulate center.
  const container = document.getElementById('scroll-container');
  const cw = container?.clientWidth ?? 0;
  const pageLeft = pageLeftRaw < 0 ? Math.max(0, (cw - pageDisplayWidth) / 2) : pageLeftRaw;
  return {
    x: pageLeft + bbox.x * zoom,
    y: pageOffset + bbox.y * zoom,
    w: bbox.w * zoom,
    h: bbox.h * zoom,
  };
}

// ─────────────────────────────────────────────────────────────
// highlightCell: per-cell bbox flash in scroll-container coords.
// Falls back to full-viewport flash if bbox cannot be resolved.
// ─────────────────────────────────────────────────────────────
function highlightCell(
  sec: number,
  para: number,
  ci: number,
  cellIndex: number,
  color?: string,
  durationMs?: number,
): void {
  const container = document.getElementById('scroll-container');
  if (!container) return;
  const rect = getCellDocRect(sec, para, ci, cellIndex);
  const flash = document.createElement('div');
  const bg = color ?? 'rgba(255, 220, 0, 0.35)';
  if (rect) {
    flash.style.cssText = [
      'position:absolute',
      `left:${rect.x}px`,
      `top:${rect.y}px`,
      `width:${rect.w}px`,
      `height:${rect.h}px`,
      `background:${bg}`,
      'outline:2px solid rgba(255,180,0,0.9)',
      'pointer-events:none',
      'transition:opacity 200ms',
      'z-index:9997',
      'border-radius:2px',
    ].join(';');
  } else {
    // Fallback: coarse viewport flash.
    flash.style.cssText = [
      'position:absolute',
      'inset:0',
      'pointer-events:none',
      `background:${color ?? 'rgba(255, 220, 0, 0.15)'}`,
      'transition:opacity 200ms',
      'z-index:9997',
    ].join(';');
  }
  container.appendChild(flash);
  const ms = durationMs ?? 800;
  window.setTimeout(() => { flash.style.opacity = '0'; }, Math.max(0, ms - 200));
  window.setTimeout(() => flash.remove(), ms);
}

// ─────────────────────────────────────────────────────────────
// scrollToCell: smooth-scroll the scroll-container so the cell
// is centered vertically in the viewport. Returns {ok:true}.
// ─────────────────────────────────────────────────────────────
function scrollToCell(
  sec: number,
  para: number,
  ci: number,
  cellIndex: number,
  behavior?: 'auto' | 'smooth',
): { ok: boolean; reason?: string } {
  const container = document.getElementById('scroll-container');
  if (!container) return { ok: false, reason: 'no-container' };
  const rect = getCellDocRect(sec, para, ci, cellIndex);
  if (!rect) return { ok: false, reason: 'no-bbox' };
  const viewportH = container.clientHeight;
  // Center vertically; clamp to [0, scrollMax].
  const target = Math.max(0, rect.y - Math.max(0, (viewportH - rect.h) / 2));
  container.scrollTo({ top: target, behavior: behavior ?? 'smooth' });
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────
window.addEventListener('message', async (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'rhwp-request' || typeof msg.method !== 'string') return;
  if (!METHODS.has(msg.method)) return;
  if (!isOriginAllowed(e.origin)) return;

  const { id, method, params } = msg as {
    id: number;
    method: string;
    params?: Record<string, unknown>;
  };
  const p = (params ?? {}) as Record<string, unknown>;
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
      // ───── Migrated legacy methods ─────
      case 'ready': {
        reply(true);
        break;
      }
      case 'loadFile': {
        const data = p.data as number[] | undefined;
        if (!data) { reply(undefined, 'loadFile: missing data'); break; }
        const bytes = new Uint8Array(data);
        const fileName = (p.fileName as string | undefined) ?? 'document.hwp';
        const skipValidationModal = !!p.skipValidationModal;
        // WASM 로딩은 동기적으로 먼저 끝낸다 (페이지 수/문서 핸들 필요).
        const docInfo = wasm.loadDocument(bytes, fileName);
        // 응답을 먼저 보낸다 — initializeDocument 가 HWPX 비표준 경고 모달을
        // 띄울 경우 사용자 응답이 있을 때까지 pending 상태로 남기 때문.
        // PoC 스트리밍은 loadFile 응답이 오는 즉시 후속 요청(setReadOnly,
        // saveSnapshot, insertTextInCell...) 을 보내므로 block 되면 안 된다.
        reply({ pageCount: docInfo.pageCount });
        // fire-and-forget: 캔버스/폰트/툴바 등 나머지 초기화 시퀀스.
        initializeDocument(
          docInfo,
          `${fileName} — ${docInfo.pageCount}페이지`,
          { skipValidationModal },
        ).catch((err) => {
          console.error('[rhwp-bridge] initializeDocument failed', err);
        });
        break;
      }
      case 'pageCount': {
        reply(wasm.pageCount);
        break;
      }
      case 'getPageSvg': {
        const page = (p.page as number | undefined) ?? 0;
        reply(wasm.renderPageSvg(page));
        break;
      }

      // ───── Existing export + event methods ─────
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
        subscriptions.get(source)?.();
        const origin = e.origin;
        const handler = () => {
          try {
            source.postMessage(
              { type: 'rhwp-event', event: 'document-changed' },
              { targetOrigin: origin },
            );
          } catch {
            subscriptions.get(source)?.();
            subscriptions.delete(source);
          }
        };
        const unsubscribe = eventBus.on('document-changed', handler) as Unsubscribe | void;
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

      // ───── Cell mutations (queued + auto-batched) ─────
      case 'insertTextInCell': {
        const sec = p.sec as number;
        const para = p.para as number;
        const ci = p.ci as number;
        const cellIndex = p.cell_index as number;
        const cellParaIdx = p.cell_para_idx as number;
        const charOffset = p.char_offset as number;
        const value = p.value as string;
        enqueueMutation(() => {
          const raw = wasm.insertTextInCell(sec, para, ci, cellIndex, cellParaIdx, charOffset, value);
          const parsed = JSON.parse(raw) as { ok?: boolean; charOffset?: number };
          return { ok: !!parsed.ok, charOffset: parsed.charOffset };
        }, reply);
        break;
      }
      case 'deleteTextInCell': {
        const sec = p.sec as number;
        const para = p.para as number;
        const ci = p.ci as number;
        const cellIndex = p.cell_index as number;
        const cellParaIdx = p.cell_para_idx as number;
        const charOffset = p.char_offset as number;
        const length = p.length as number;
        enqueueMutation(() => {
          wasm.deleteTextInCell(sec, para, ci, cellIndex, cellParaIdx, charOffset, length);
          return { ok: true };
        }, reply);
        break;
      }
      case 'setFieldValueByName': {
        const name = p.name as string;
        const value = p.value as string;
        enqueueMutation(() => {
          wasm.setFieldValueByName(name, value);
          return { ok: true };
        }, reply);
        break;
      }
      case 'replaceText': {
        const sec = p.sec as number;
        const para = p.para as number;
        const charOffset = p.char_offset as number;
        const length = p.length as number;
        const value = p.value as string;
        enqueueMutation(() => {
          wasm.replaceText(sec, para, charOffset, length, value);
          return { ok: true };
        }, reply);
        break;
      }

      // ───── Explicit batch ─────
      case 'beginBatch': {
        flushPendingNow();
        try {
          rawDoc()?.beginBatch();
          explicitBatchOpen = true;
          reply({ ok: true });
        } catch (err) {
          reply(undefined, err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case 'endBatch': {
        flushPendingNow();
        try {
          rawDoc()?.endBatch();
          explicitBatchOpen = false;
          // 명시적 batch 종료 후에도 캔버스 재렌더 + document-changed 알림.
          try {
            refreshDocumentView();
          } catch (err) {
            console.error('[rhwp-bridge] refreshDocumentView failed (endBatch)', err);
          }
          try {
            eventBus.emit('document-changed');
          } catch (err) {
            console.error('[rhwp-bridge] eventBus.emit failed (endBatch)', err);
          }
          reply({ ok: true });
        } catch (err) {
          reply(undefined, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      // ───── Snapshots (name → wasm-id) ─────
      case 'saveSnapshot': {
        const name = p.name as string;
        if (!name) { reply(undefined, 'saveSnapshot: missing name'); break; }
        // Supersede any prior snapshot under the same name to avoid leaks.
        const prev = snapshotIds.get(name);
        if (prev !== undefined) {
          try { wasm.discardSnapshot(prev); } catch { /* ignore */ }
        }
        const wasmId = wasm.saveSnapshot();
        snapshotIds.set(name, wasmId);
        reply({ ok: true });
        break;
      }
      case 'restoreSnapshot': {
        const name = p.name as string;
        const wasmId = snapshotIds.get(name);
        if (wasmId === undefined) { reply(undefined, `no such snapshot: ${name}`); break; }
        // Flush pending mutations so they don't apply *after* restoration.
        flushPendingNow();
        wasm.restoreSnapshot(wasmId);
        reply({ ok: true });
        break;
      }
      case 'discardSnapshot': {
        const name = p.name as string;
        const wasmId = snapshotIds.get(name);
        if (wasmId !== undefined) {
          try { wasm.discardSnapshot(wasmId); } catch { /* ignore */ }
          snapshotIds.delete(name);
        }
        reply({ ok: true });
        break;
      }

      // ───── Studio-layer helpers ─────
      case 'setReadOnly': {
        setReadOnly(!!p.enabled);
        reply({ ok: true });
        break;
      }
      case 'highlightCell': {
        highlightCell(
          p.sec as number,
          p.para as number,
          p.ci as number,
          p.cell_index as number,
          p.color as string | undefined,
          p.duration_ms as number | undefined,
        );
        reply({ ok: true });
        break;
      }
      case 'scrollToCell': {
        const r = scrollToCell(
          p.sec as number,
          p.para as number,
          p.ci as number,
          p.cell_index as number,
          p.behavior as 'auto' | 'smooth' | undefined,
        );
        reply(r);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply(undefined, message);
  }
});

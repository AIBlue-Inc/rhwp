/**
 * HTATIS host bridge for rhwp-studio.
 *
 * HTATIS (aiblue-htalgims-fe) embeds the studio same-origin and drives it with the legacy
 * `{ type: 'rhwp-request', id, method, params }` postMessage protocol: document load/export,
 * queued cell mutations, explicit batches, snapshots, studio overlays and the canonical
 * operation batch (`rhwp-operation-batch.ts`).
 *
 * The embed runtime (`embed/runtime.ts`) also answers legacy `rhwp-request`s and replies
 * `Unknown method` to anything it does not route, so this bridge has to see a request first:
 * main.ts installs it before `installEmbedRuntime`, and for HTATIS_METHODS from an allowed
 * origin the bridge stops propagation so a request never gets two replies. `ready`,
 * `rhwp-connect` sessions and embed-only methods fall through to the embed runtime.
 *
 * The first claimed request switches the studio into host mode (`enterHostMode`): HTATIS owns
 * persistence, so studio autosave drafts, crash-recovery restore, the unsaved-changes
 * `beforeunload` prompt and recent-document entries are off for the rest of the session.
 */
import type { WasmBridge } from './core/wasm-bridge';
import type { EventBus } from './core/event-bus';
import type { DocumentPosition } from './core/types';
import type { CanvasView } from './view/canvas-view';
import type { InputHandler } from './engine/input-handler';
import { createOperationBridge, type OperationDocument } from './rhwp-operation-batch.ts';

export const HTATIS_METHODS: ReadonlySet<string> = new Set([
  // document load/read/export — serialized with the mutation queue
  'loadFile', 'pageCount', 'getPageSvg', 'exportHwp', 'exportHwpx', 'subscribeChange',
  // introspection for the LLM editing pipeline
  'getPageTextLayout', 'getPageControlLayout', 'getDocumentInfo',
  // cell mutations (queued + auto-batched)
  'insertTextInCell', 'deleteTextInCell', 'setFieldValueByName', 'replaceText',
  'insertPictureAtCursor',
  // explicit batching and snapshots (name → wasm id)
  'beginBatch', 'endBatch', 'saveSnapshot', 'restoreSnapshot', 'discardSnapshot',
  // studio-layer helpers
  'setReadOnly', 'highlightCell', 'scrollToCell',
  // canonical server operation batch preview
  'applyOperationBatch', 'readTargets',
]);

export interface HtatisBridgeHost {
  hostWindow: Pick<Window, 'addEventListener' | 'removeEventListener'> & {
    location: { origin: string };
  };
  /** The only window allowed to drive the bridge: the embedding parent (`window` when top-level). */
  parentWindow: unknown;
  /** Called once, on the first claimed request — the host owns persistence from then on. */
  enterHostMode(): void;
  wasm: WasmBridge;
  eventBus: Pick<EventBus, 'on' | 'emit'>;
  /**
   * Opens bytes without studio dialogs (unsaved guard, local-font prompt). Resolves once the
   * document is parsed; fonts and the view keep initializing in the background.
   */
  loadDocument(data: Uint8Array, fileName: string): Promise<{ pageCount: number }>;
  refreshDocumentView(): void;
  getCanvasView(): CanvasView | null;
  getInputHandler(): InputHandler | null;
}

declare const __RHWP_EXTRA_ORIGINS__: string | undefined;

type Reply = (result?: unknown, error?: string) => void;
type ReplyTarget = { postMessage(message: unknown, options: { targetOrigin: string }): void };

interface DocRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// WASM is single-threaded, so cell mutations run serially. The first mutation opens an implicit
// wasm batch and an 80ms timer; later mutations join the queue and the timer drains them in one
// pass, collapsing repagination to a single cycle. An explicit beginBatch flushes the timer and
// keeps the batch open until the matching endBatch.
const AUTO_BATCH_WINDOW_MS = 80;

export function installHtatisBridge(host: HtatisBridgeHost): () => void {
  const { wasm, eventBus } = host;
  const extraOrigins = typeof __RHWP_EXTRA_ORIGINS__ === 'string' ? __RHWP_EXTRA_ORIGINS__ : '';
  const allowedOrigins = new Set(
    [host.hostWindow.location.origin, ...extraOrigins.split(',').map((s) => s.trim())].filter(Boolean),
  );
  const isOriginAllowed = (origin: string) => origin !== 'null' && allowedOrigins.has(origin);

  const subscriptions = new WeakMap<object, () => void>();
  const snapshotIds = new Map<string, number>();
  const mutationQueue: { fn: () => unknown; reply: Reply }[] = [];
  let autoBatchOpen = false;
  let explicitBatchOpen = false;
  let autoBatchTimer: ReturnType<typeof setTimeout> | null = null;
  let draining = false;

  // WasmBridge keeps the HwpDocument private; the operation contracts need the raw JSON APIs.
  const rawDoc = (): OperationDocument | null =>
    (wasm as unknown as { doc?: OperationDocument | null }).doc ?? null;

  function notifyDocumentChanged(label: string): void {
    try {
      host.refreshDocumentView();
    } catch (err) {
      console.error(`[rhwp-bridge] refreshDocumentView failed (${label})`, err);
    }
    try {
      eventBus.emit('document-changed');
    } catch (err) {
      console.error(`[rhwp-bridge] document-changed failed (${label})`, err);
    }
  }

  function beginBatchIfNeeded(): void {
    if (autoBatchOpen || explicitBatchOpen) return;
    try {
      rawDoc()?.beginBatch();
      autoBatchOpen = true;
    } catch (err) {
      console.error('[rhwp-bridge] beginBatch failed', err);
    }
  }

  function closeAutoBatchIfOpen(): void {
    if (!autoBatchOpen || explicitBatchOpen) return;
    try {
      rawDoc()?.endBatch();
    } catch (err) {
      console.error('[rhwp-bridge] endBatch failed', err);
    }
    autoBatchOpen = false;
    notifyDocumentChanged('auto batch');
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (mutationQueue.length) {
        const { fn, reply } = mutationQueue.shift()!;
        try {
          reply(fn());
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

  function flushPendingNow(): void {
    if (autoBatchTimer !== null) {
      clearTimeout(autoBatchTimer);
      autoBatchTimer = null;
    }
    drain();
  }

  function enqueueMutation(fn: () => unknown, reply: Reply): void {
    beginBatchIfNeeded();
    mutationQueue.push({ fn, reply });
    if (explicitBatchOpen) {
      // The caller owns endBatch: run now, still serially.
      drain();
    } else if (autoBatchTimer === null) {
      autoBatchTimer = setTimeout(() => {
        autoBatchTimer = null;
        drain();
      }, AUTO_BATCH_WINDOW_MS);
    }
  }

  const operationBridge = createOperationBridge({
    wasm,
    rawDoc,
    flushPendingNow,
    isExplicitBatchOpen: () => explicitBatchOpen,
    refreshDocumentView: () => host.refreshDocumentView(),
    notifyChanged: () => eventBus.emit('document-changed'),
  });

  // setReadOnly: a full-viewport overlay inside the iframe document, rather than an input-handler
  // guard, to keep the studio diff small.
  let readonlyOverlay: HTMLDivElement | null = null;

  function setReadOnly(enabled: boolean): void {
    if (!enabled) {
      readonlyOverlay?.remove();
      readonlyOverlay = null;
      return;
    }
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
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    for (const name of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup']) {
      overlay.addEventListener(name, swallow, true);
    }
    overlay.addEventListener('wheel', (e) => e.stopPropagation(), { capture: true, passive: true });
    document.body.appendChild(overlay);
    readonlyOverlay = overlay;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  /**
   * Cell bbox → scroll-container doc-space rect. getTableCellBboxes returns zoomed page-local
   * px per page; docY = pageOffset[page] + y, docX = pageLeft[page] + x.
   */
  function getCellDocRect(sec: number, para: number, ci: number, cellIndex: number): DocRect | null {
    const canvasView = host.getCanvasView();
    if (!canvasView) return null;
    const virtualScroll = canvasView.getVirtualScroll();
    const zoom = canvasView.getViewportManager()?.getZoom?.() ?? 1.0;
    let bboxes;
    try {
      bboxes = wasm.getTableCellBboxes(sec, para, ci, 0);
    } catch (err) {
      console.warn('[rhwp-bridge] getTableCellBboxes failed', err);
      return null;
    }
    const bbox = bboxes.find((b) => b.cellIdx === cellIndex) ?? bboxes[0];
    if (!bbox) return null;
    const pageLeftRaw = virtualScroll.getPageLeft(bbox.pageIndex);
    const pageWidth = virtualScroll.getPageWidth(bbox.pageIndex);
    // getPageLeft returns -1 when the page is CSS-centred.
    const containerWidth = document.getElementById('scroll-container')?.clientWidth ?? 0;
    const pageLeft = pageLeftRaw < 0 ? Math.max(0, (containerWidth - pageWidth) / 2) : pageLeftRaw;
    return {
      x: pageLeft + bbox.x * zoom,
      y: virtualScroll.getPageOffset(bbox.pageIndex) + bbox.y * zoom,
      w: bbox.w * zoom,
      h: bbox.h * zoom,
    };
  }

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
    flash.style.cssText = (rect
      ? [
          'position:absolute',
          `left:${rect.x}px`,
          `top:${rect.y}px`,
          `width:${rect.w}px`,
          `height:${rect.h}px`,
          `background:${color ?? 'rgba(255, 220, 0, 0.35)'}`,
          'outline:2px solid rgba(255,180,0,0.9)',
          'border-radius:2px',
        ]
      : ['position:absolute', 'inset:0', `background:${color ?? 'rgba(255, 220, 0, 0.15)'}`]
    ).concat(['pointer-events:none', 'transition:opacity 200ms', 'z-index:9997']).join(';');
    container.appendChild(flash);
    const ms = durationMs ?? 800;
    setTimeout(() => {
      flash.style.opacity = '0';
    }, Math.max(0, ms - 200));
    setTimeout(() => flash.remove(), ms);
  }

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
    // Centre vertically.
    const top = Math.max(0, rect.y - Math.max(0, (container.clientHeight - rect.h) / 2));
    container.scrollTo({ top, behavior: behavior ?? 'smooth' });
    return { ok: true };
  }

  async function insertPictureAtCursor(p: Record<string, unknown>): Promise<{ ok: true }> {
    const { dataBase64, mime } = p;
    if (typeof dataBase64 !== 'string') throw new Error('insertPictureAtCursor: missing dataBase64');
    if (typeof mime !== 'string') throw new Error('insertPictureAtCursor: missing mime');
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : null;
    if (!ext) throw new Error(`insertPictureAtCursor: unsupported mime: ${mime}`);

    const data = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const img = new Image();
    try {
      img.src = url;
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    const inputHandler = host.getInputHandler();
    if (!inputHandler) throw new Error('insertPictureAtCursor: editor not initialized');

    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    let width = Math.round(naturalWidth * 75);
    let height = Math.round(naturalHeight * 75);
    try {
      const pageDef = wasm.getPageDef(inputHandler.getCursorPosition().sectionIndex);
      const columnWidth = pageDef.width - pageDef.marginLeft - pageDef.marginRight;
      if (width > columnWidth) {
        height = Math.round((height * columnWidth) / width);
        width = Math.round(columnWidth);
      }
    } catch {
      /* no page info: keep the natural size */
    }

    let inserted = false;
    // insertPicture places a floating picture; like the studio's own drop insert
    // (input-handler.ts), switch it to treat-as-char in the same snapshot so it sits inline at
    // the caret and undo removes both steps at once.
    inputHandler.executeOperation({
      kind: 'snapshot',
      operationType: 'pasteImage',
      operation: (op): DocumentPosition | null => {
        const pos = inputHandler.getCursorPosition();
        const hasPath = (pos.cellPath?.length ?? 0) > 0 && pos.parentParaIndex !== undefined;
        const inTextBox = hasPath && pos.isTextBox === true;
        const paraIdx = hasPath ? pos.parentParaIndex! : pos.paragraphIndex;
        const cellPath = hasPath ? pos.cellPath ?? [] : [];
        const result = op.insertPicture(
          pos.sectionIndex, paraIdx, pos.charOffset,
          cellPath.length ? JSON.stringify(cellPath) : '',
          data, width, height, naturalWidth, naturalHeight, ext, '',
        );
        if (!result.ok) return null;
        inserted = true;
        const hostPara = result.paraIdx ?? paraIdx;
        if (inTextBox) {
          op.setCellPicturePropertiesByPath(pos.sectionIndex, paraIdx, cellPath, result.controlIdx, { treatAsChar: true });
        } else {
          op.setPictureProperties(pos.sectionIndex, hostPara, result.controlIdx, { treatAsChar: true });
        }
        const charOffset = typeof result.logicalOffset === 'number' ? result.logicalOffset : pos.charOffset + 1;
        return inTextBox
          ? { ...pos, charOffset }
          : { sectionIndex: pos.sectionIndex, paragraphIndex: hostPara, charOffset };
      },
    });
    if (!inserted) throw new Error('insertPictureAtCursor: insertPicture failed');
    return { ok: true };
  }

  async function handleRequest(event: MessageEvent): Promise<void> {
    const { id, method, params } = event.data as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    const p = params && typeof params === 'object' ? params : {};
    const source = event.source as ReplyTarget | null;
    const reply: Reply = (result, error) => {
      if (!source) return;
      try {
        source.postMessage({ type: 'rhwp-response', id, result, error }, { targetOrigin: event.origin });
      } catch {
        /* source closed */
      }
    };

    try {
      switch (method) {
        // ───── Document load / read / export ─────
        case 'loadFile': {
          const data = p.data;
          const bytes = data instanceof Uint8Array ? data
            : data instanceof ArrayBuffer ? new Uint8Array(data)
              : Array.isArray(data) ? new Uint8Array(data) : null;
          if (!bytes) {
            reply(undefined, 'loadFile: missing data');
            break;
          }
          // Apply what is still queued to the outgoing document; its batches and snapshot ids
          // do not carry over. `skipValidationModal` is accepted for compatibility — host loads
          // never open studio dialogs.
          flushPendingNow();
          explicitBatchOpen = false;
          snapshotIds.clear();
          const fileName = typeof p.fileName === 'string' ? p.fileName : 'document.hwp';
          reply(await host.loadDocument(bytes, fileName));
          break;
        }
        case 'pageCount':
          reply(wasm.pageCount);
          break;
        case 'getPageSvg':
          reply(wasm.renderPageSvg(typeof p.page === 'number' ? p.page : 0));
          break;
        case 'exportHwp':
          flushPendingNow();
          reply(Array.from(wasm.exportHwp()));
          break;
        case 'exportHwpx':
          flushPendingNow();
          reply(Array.from(wasm.exportHwpx()));
          break;
        case 'subscribeChange': {
          if (!source) {
            reply(undefined, 'no source window');
            break;
          }
          subscriptions.get(source)?.();
          const origin = event.origin;
          const unsubscribe = eventBus.on('document-changed', () => {
            try {
              source.postMessage({ type: 'rhwp-event', event: 'document-changed' }, { targetOrigin: origin });
            } catch {
              subscriptions.get(source)?.();
              subscriptions.delete(source);
            }
          });
          subscriptions.set(source, unsubscribe);
          reply(true);
          break;
        }

        // ───── Introspection ─────
        case 'getPageTextLayout': {
          const doc = rawDoc();
          if (!doc) throw new Error('문서가 로드되지 않았습니다');
          reply(JSON.parse(doc.getPageTextLayout(typeof p.page === 'number' ? p.page : 0)));
          break;
        }
        case 'getPageControlLayout':
          reply(wasm.getPageControlLayout(typeof p.page === 'number' ? p.page : 0));
          break;
        case 'getDocumentInfo':
          reply(wasm.getDocumentInfo());
          break;
        case 'applyOperationBatch':
          reply(await operationBridge.applyOperationBatch(p.operations));
          break;
        case 'readTargets':
          reply(operationBridge.readTargets(p.targets));
          break;

        // ───── Cell mutations (queued + auto-batched) ─────
        case 'insertTextInCell': {
          const { sec, para, ci, cell_index, cell_para_idx, char_offset, value } = p as Record<string, number & string>;
          enqueueMutation(() => {
            const parsed = JSON.parse(wasm.insertTextInCell(sec, para, ci, cell_index, cell_para_idx, char_offset, value)) as {
              ok?: boolean;
              charOffset?: number;
            };
            return { ok: !!parsed.ok, charOffset: parsed.charOffset };
          }, reply);
          break;
        }
        case 'deleteTextInCell': {
          const { sec, para, ci, cell_index, cell_para_idx, char_offset, length } = p as Record<string, number>;
          enqueueMutation(() => {
            wasm.deleteTextInCell(sec, para, ci, cell_index, cell_para_idx, char_offset, length);
            return { ok: true };
          }, reply);
          break;
        }
        case 'setFieldValueByName': {
          const { name, value } = p as Record<string, string>;
          enqueueMutation(() => {
            wasm.setFieldValueByName(name, value);
            return { ok: true };
          }, reply);
          break;
        }
        case 'replaceText': {
          const { sec, para, char_offset, length, value } = p as Record<string, number & string>;
          enqueueMutation(() => {
            wasm.replaceText(sec, para, char_offset, length, value);
            return { ok: true };
          }, reply);
          break;
        }
        case 'insertPictureAtCursor':
          flushPendingNow();
          reply(await insertPictureAtCursor(p));
          break;

        // ───── Explicit batch ─────
        case 'beginBatch':
          flushPendingNow();
          rawDoc()?.beginBatch();
          explicitBatchOpen = true;
          reply({ ok: true });
          break;
        case 'endBatch':
          flushPendingNow();
          rawDoc()?.endBatch();
          explicitBatchOpen = false;
          notifyDocumentChanged('endBatch');
          reply({ ok: true });
          break;

        // ───── Snapshots (name → wasm id) ─────
        case 'saveSnapshot': {
          const name = p.name;
          if (typeof name !== 'string' || !name) {
            reply(undefined, 'saveSnapshot: missing name');
            break;
          }
          // Supersede an earlier snapshot under the same name so ids do not leak.
          const previous = snapshotIds.get(name);
          if (previous !== undefined) {
            try {
              wasm.discardSnapshot(previous);
            } catch {
              /* already gone */
            }
          }
          snapshotIds.set(name, wasm.saveSnapshot());
          reply({ ok: true });
          break;
        }
        case 'restoreSnapshot': {
          const wasmId = snapshotIds.get(p.name as string);
          if (wasmId === undefined) {
            reply(undefined, `no such snapshot: ${String(p.name)}`);
            break;
          }
          // Queued mutations must not land after the restore.
          flushPendingNow();
          wasm.restoreSnapshot(wasmId);
          reply({ ok: true });
          break;
        }
        case 'discardSnapshot': {
          const name = p.name as string;
          const wasmId = snapshotIds.get(name);
          if (wasmId !== undefined) {
            try {
              wasm.discardSnapshot(wasmId);
            } catch {
              /* already gone */
            }
            snapshotIds.delete(name);
          }
          reply({ ok: true });
          break;
        }

        // ───── Studio-layer helpers ─────
        case 'setReadOnly':
          setReadOnly(!!p.enabled);
          reply({ ok: true });
          break;
        case 'highlightCell':
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
        case 'scrollToCell':
          reply(scrollToCell(
            p.sec as number,
            p.para as number,
            p.ci as number,
            p.cell_index as number,
            p.behavior as 'auto' | 'smooth' | undefined,
          ));
          break;
      }
    } catch (err) {
      reply(undefined, err instanceof Error ? err.message : String(err));
    }
  }

  // Serialize requests: applyOperationBatch awaits Web Crypto hashing, and read-back, load,
  // restore or export must not overtake a batch while it waits.
  let requestQueue: Promise<void> = Promise.resolve();
  let hostModeEntered = false;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; method?: unknown } | null;
    if (!data || typeof data !== 'object' || data.type !== 'rhwp-request'
      || typeof data.method !== 'string' || !HTATIS_METHODS.has(data.method)
      || !isOriginAllowed(event.origin) || event.source !== host.parentWindow) return;
    // The embed runtime would answer this request again with `Unknown method`.
    event.stopImmediatePropagation();
    if (!hostModeEntered) {
      hostModeEntered = true;
      host.enterHostMode();
    }
    requestQueue = requestQueue.then(() => handleRequest(event)).catch((error) => {
      console.error('[rhwp-bridge] request failed', error);
    });
  };
  host.hostWindow.addEventListener('message', onMessage as EventListener);
  return () => {
    host.hostWindow.removeEventListener('message', onMessage as EventListener);
    if (autoBatchTimer !== null) clearTimeout(autoBatchTimer);
    autoBatchTimer = null;
  };
}

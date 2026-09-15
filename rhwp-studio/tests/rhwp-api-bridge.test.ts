import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installEmbedRuntime } from '../src/embed/runtime.ts';
import { HTATIS_METHODS, installHtatisBridge, type HtatisBridgeHost } from '../src/rhwp-api-bridge.ts';

// A window that dispatches `message` to its listeners in registration order and honours
// stopImmediatePropagation, as the browser does — main.ts installs the bridge first.
function fakeWindow(origin = 'https://studio.test') {
  const listeners: ((event: any) => void)[] = [];
  return {
    location: { origin },
    addEventListener: (_name: string, handler: (event: any) => void) => { listeners.push(handler); },
    removeEventListener: (_name: string, handler: (event: any) => void) => {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(event: any): boolean {
      let stopped = false;
      event.stopImmediatePropagation = () => { stopped = true; };
      for (const listener of [...listeners]) {
        listener(event);
        if (stopped) break;
      }
      return stopped;
    },
  };
}

function harness(options: { loadDocument?: HtatisBridgeHost['loadDocument'] } = {}) {
  const hostWindow = fakeWindow();
  const replies: any[] = [];
  const calls: unknown[][] = [];
  const parent = { postMessage: (reply: unknown) => replies.push(reply) };
  let hostModeCount = 0;
  const doc = {
    beginBatch() { calls.push(['beginBatch']); },
    endBatch() { calls.push(['endBatch']); },
    pageCount: () => 1,
    renderPageSvg: () => '<svg/>',
    getParagraphLength: () => 2,
    getTextRange: () => '본문',
  };
  const wasm = {
    doc,
    pageCount: 1,
    exportHwp: () => new Uint8Array([7, 8]),
    insertTextInCell: (...args: unknown[]) => {
      calls.push(['insertTextInCell', ...args]);
      return JSON.stringify({ ok: true, charOffset: 3 });
    },
  };
  const host = {
    hostWindow,
    parentWindow: parent,
    wasm,
    eventBus: { on: () => () => {}, emit: (name: string) => { calls.push(['emit', name]); } },
    enterHostMode: () => { hostModeCount++; },
    loadDocument: options.loadDocument ?? (async (data: Uint8Array, fileName: string) => {
      calls.push(['loadDocument', Array.from(data), fileName]);
      return { pageCount: 3 };
    }),
    refreshDocumentView: () => { calls.push(['refresh']); },
    getCanvasView: () => null,
    getInputHandler: () => null,
  } as unknown as HtatisBridgeHost;
  const uninstall = installHtatisBridge(host);
  const send = (
    id: number,
    method: string,
    params = {},
    { origin = 'https://studio.test', source = parent as unknown } = {},
  ) => hostWindow.dispatch({ origin, source, ports: [], data: { type: 'rhwp-request', id, method, params } });
  return { hostWindow, parent, send, replies, calls, uninstall, hostModeCount: () => hostModeCount };
}

test('bridge claims only its methods from the parent window of an allowed origin', () => {
  const h = harness();
  assert.equal(h.send(1, 'ready'), false);
  assert.equal(h.send(2, 'getRendererDiagnostics'), false);
  assert.equal(h.send(3, 'readTargets', {}, { origin: 'https://untrusted.test' }), false);
  assert.equal(h.send(4, 'readTargets', {}, { origin: 'null' }), false);
  assert.equal(h.send(5, 'readTargets', {}, { source: { postMessage() {} } }), false);
  assert.equal(HTATIS_METHODS.has('ready'), false);
  assert.equal(h.hostModeCount(), 0);
  assert.equal(h.send(6, 'readTargets', { targets: [] }), true);
  assert.equal(h.send(7, 'readTargets', { targets: [] }), true);
  assert.equal(h.hostModeCount(), 1, 'host mode is entered once, on the first claimed request');
  h.uninstall();
});

test('with the real embed runtime installed after it, every request gets exactly one reply', async () => {
  const h = harness();
  const uninstallRuntime = installEmbedRuntime({
    hostWindow: h.hostWindow as unknown as Window,
    parentWindow: h.parent as unknown as Window,
    handlers: { ready: async () => true } as unknown as Parameters<typeof installEmbedRuntime>[0]['handlers'],
  });
  h.send(1, 'readTargets', { targets: [{ kind: 'paragraph', sec: 0, para: 0 }] });
  h.send(2, 'ready');
  h.send(3, 'noSuchMethod');
  await setImmediate();
  await setImmediate();
  assert.deepEqual(h.replies.map((reply) => reply.id).sort(), [1, 2, 3]);
  assert.equal(h.replies.find((reply) => reply.id === 1).result.targets[0].text, '본문');
  assert.equal(h.replies.find((reply) => reply.id === 2).result, true);
  assert.match(h.replies.find((reply) => reply.id === 3).error, /Unknown method/);
  uninstallRuntime();
  h.uninstall();
});

test('requests are serialized behind stamp hashing and replies keep request order', async (t) => {
  let hashingStarted = false;
  let releaseHash!: (hash: ArrayBuffer) => void;
  t.mock.method(globalThis.crypto.subtle, 'digest', () => {
    hashingStarted = true;
    return new Promise<ArrayBuffer>((resolve) => { releaseHash = resolve; });
  });
  const h = harness();
  h.send(1, 'applyOperationBatch', { operations: [{ op: 'insertPictureAtMatch', image: {
    data_base64: 'iVBORw0KGgo=', extension: 'png', sha256: '0'.repeat(64),
  } }] });
  h.send(2, 'readTargets', { targets: [{ kind: 'paragraph', sec: 0, para: 0 }] });
  await setImmediate();
  assert.equal(hashingStarted, true);
  assert.deepEqual(h.replies, []);
  releaseHash(new ArrayBuffer(32));
  await setImmediate();
  assert.deepEqual(h.replies.map((reply) => reply.id), [1, 2]);
  assert.equal(h.replies[0].result.applied[0].error, 'stamp_api_unavailable');
  assert.equal(h.replies[1].result.targets[0].text, '본문');
  h.uninstall();
});

test('export and loadFile apply queued cell mutations to the current document first', async () => {
  const h = harness();
  h.send(1, 'insertTextInCell', { sec: 0, para: 0, ci: 0, cell_index: 1, cell_para_idx: 0, char_offset: 0, value: 'A' });
  h.send(2, 'exportHwp');
  h.send(3, 'loadFile', { data: [1, 2], fileName: 'next.hwp', skipValidationModal: true });
  await setImmediate();
  await setImmediate();
  assert.deepEqual(h.replies.map((reply) => [reply.id, reply.result]), [
    [1, { ok: true, charOffset: 3 }],
    [2, [7, 8]],
    [3, { pageCount: 3 }],
  ]);
  const order = h.calls.map((call) => call[0]);
  assert.ok(order.indexOf('insertTextInCell') < order.indexOf('endBatch'));
  assert.ok(order.indexOf('endBatch') < order.indexOf('loadDocument'));
  assert.deepEqual(h.calls.find((call) => call[0] === 'loadDocument'), ['loadDocument', [1, 2], 'next.hwp']);
  h.uninstall();
});

test('a failed loadFile replies with the error and later requests still run', async () => {
  const h = harness({ loadDocument: async () => { throw new Error('corrupt document'); } });
  h.send(1, 'loadFile', { data: [1] });
  h.send(2, 'pageCount');
  await setImmediate();
  await setImmediate();
  assert.deepEqual(h.replies.map((reply) => [reply.id, reply.result, reply.error]), [
    [1, undefined, 'corrupt document'],
    [2, 1, undefined],
  ]);
  h.uninstall();
});

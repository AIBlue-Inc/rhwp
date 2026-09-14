import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';

// Exercise the real dispatcher and main -> bridge -> main import cycle with a DOM-free main.
test('dispatcher initializes lazily and serializes read-back behind stamp hashing', async (t) => {
  const bridgeUrl = new URL('../src/rhwp-api-bridge.ts', import.meta.url).href;
  const mainUrl = new URL('../src/main.ts', import.meta.url).href;
  const operationsUrl = new URL('../src/rhwp-operation-batch.ts', import.meta.url).href;
  let listener: (event: unknown) => void;
  const replies: any[] = [];
  let hashingStarted = false;
  let releaseHash: (hash: ArrayBuffer) => void;
  t.mock.method(globalThis.crypto.subtle, 'digest', () => {
    hashingStarted = true;
    return new Promise<ArrayBuffer>(resolve => { releaseHash = resolve; });
  });
  const scope = globalThis as any;
  scope.window = { location: { origin: 'https://studio.test' },
    addEventListener: (_name: string, handler: typeof listener) => { listener = handler; } };
  const doc = {
    beginBatch() {}, endBatch() {}, pageCount: () => 1, renderPageSvg: () => '<svg/>',
    getParagraphLength: () => 4, getTextRange: () => '본문',
  };
  scope.__testBridgeWasm = { doc, pageCount: 1 };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === './main' && context.parentURL === bridgeUrl) return { url: mainUrl, shortCircuit: true };
      if (specifier === './rhwp-operation-batch' && context.parentURL === bridgeUrl) return { url: operationsUrl, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === mainUrl) return { format: 'module', shortCircuit: true, source: `
        import ${JSON.stringify(bridgeUrl)};
        export const wasm = globalThis.__testBridgeWasm;
        export const eventBus = { emit() {} };
        export function refreshDocumentView() {}
        export function initializeDocument() {}
        export function getCanvasView() {}
        export function getInputHandler() {}
      ` };
      return next(url, context);
    },
  });
  t.after(() => { hooks.deregister(); delete scope.window; delete scope.__testBridgeWasm; });
  await import(mainUrl);
  const send = (id: number, method: string, params = {}, origin = 'https://studio.test') => listener({
    origin, data: { type: 'rhwp-request', id, method, params },
    source: { postMessage: (reply: unknown) => replies.push(reply) },
  });
  send(0, 'readTargets', {}, 'https://untrusted.test');
  send(1, 'applyOperationBatch', { operations: [{ op: 'insertPictureAtMatch', image: {
    data_base64: 'iVBORw0KGgo=', extension: 'png', sha256: '0'.repeat(64),
  } }] });
  send(2, 'readTargets', { targets: [{ kind: 'paragraph', sec: 0, para: 0 }] });
  await setImmediate();
  assert.equal(hashingStarted, true);
  assert.deepEqual(replies, []);
  releaseHash!(new ArrayBuffer(32));
  await setImmediate();
  assert.deepEqual(replies.map(reply => reply.id), [1, 2]);
  assert.equal(replies[0].result.applied[0].error, 'stamp_api_unavailable');
  assert.equal(replies[1].result.targets[0].text, '본문');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createOperationBridge, normalizeCellText, findTextMatch, readCellParagraphs,
  stampMatchBbox, stampHostParagraph, decodeStampImage, type OperationDocument,
} from '../src/rhwp-operation-batch.ts';

const json = JSON.stringify;
const ok = () => json({ ok: true });
const target = { kind: 'paragraph', sec: 0, para: 0, ci: 0, cell_index: 1, cell_para_idx: 0 };
const run = (extra = {}) => ({ secIdx: 0, paraIdx: 0, charStart: 0, text: '(인)',
  x: 10, y: 20, w: 15, h: 10, charX: [0, 4, 10, 15], ...extra });
const cellRun = (extra = {}) => run({ parentParaIdx: 0, controlIdx: 0,
  cellIdx: 1, cellParaIdx: 0, cellPath: [{}], ...extra });
const table = { type: 'table', secIdx: 0, paraIdx: 0, controlIdx: 0,
  x: 0, y: 10, w: 100, h: 100,
  cells: [{ cellIdx: 77, row: 2, col: 3, x: 5, y: 15, w: 60, h: 30 }] };
const png = Buffer.from('89504e470d0a1a0a0001', 'hex');
function image(bytes = png, extension = 'png') {
  return { data_base64: bytes.toString('base64'), extension,
    sha256: createHash('sha256').update(bytes).digest('hex'), natural_width_px: 12, natural_height_px: 8 };
}
function stamp(extra = {}) {
  return { op: 'insertPictureAtMatch', target: { ...target }, find: { text: '(인)', occurrence: 1 },
    image: image(), size: { width_hwpunit: 600, height_hwpunit: 400 },
    placement: { mode: 'over_match', dx_hwpunit: 3, dy_hwpunit: -2 }, description: 'stamp-rule-1', ...extra };
}
function fixture() {
  const state = {
    paragraphs: ['(인)', '본문', '다음'], cells: [['first', ''], ['(인)', '😀A\u2007\u2007B']],
    runs: [[run()]] as ReturnType<typeof run>[][],
    controls: [[table]], positions: new Map<number, number[]>(),
    pictures: new Map<string, Record<string, unknown>>(), events: [] as string[], batch: false,
    calls: [] as unknown[][], coords: [{ row: 0, col: 0 }, { row: 2, col: 3 }],
  };
  const doc = {
    beginBatch() { assert.equal(state.batch, false); state.batch = true; state.events.push('begin'); return ok(); },
    endBatch() { assert.equal(state.batch, true); state.batch = false; state.events.push('end'); return ok(); },
    pageCount: () => state.runs.length,
    renderPageSvg(page: number) { assert.equal(state.batch, false); state.events.push(`render:${page}`); return '<svg/>'; },
    getPageTextLayout(page: number) { state.events.push(`layout:${page}`); return json({ runs: state.runs[page] }); },
    getPageControlLayout: (page: number) => json({ controls: state.controls[page] || [] }),
    getCellInfo: (_s: number, _p: number, _c: number, i: number) => json(state.coords[i]),
    getParagraphCount: () => state.paragraphs.length,
    getParagraphLength: (_s: number, p: number) => Array.from(state.paragraphs[p]).length,
    getTextRange: (_s: number, p: number, start: number, length: number) => Array.from(state.paragraphs[p]).slice(start, start + length).join(''),
    getCellParagraphCount: (_s: number, _p: number, _c: number, i: number) => state.cells[i].length,
    getCellParagraphLength: (_s: number, _p: number, _c: number, i: number, cp: number) => Array.from(state.cells[i][cp]).length,
    getTextInCell: (_s: number, _p: number, _c: number, i: number, cp: number, start: number, length: number) => Array.from(state.cells[i][cp]).slice(start, start + length).join(''),
    getControlTextPositions: (_s: number, p: number) => json(state.positions.get(p) || []),
    getPictureProperties(_s: number, p: number, ci: number) {
      const props = state.pictures.get(`${p}:${ci}`);
      if (!props) throw new Error('not a picture');
      return json(props);
    },
    replaceText(...args: [number, number, number, number, string]) {
      state.calls.push(['replace', ...args]);
      const [, p, start, length, text] = args;
      const chars = Array.from(state.paragraphs[p]); chars.splice(start, length, text);
      state.paragraphs[p] = chars.join(''); return ok();
    },
    deleteTextInCell(...args: [number, number, number, number, number, number, number]) {
      state.calls.push(['delete', ...args]);
      const [, , , i, cp, start, length] = args;
      const chars = Array.from(state.cells[i][cp]); chars.splice(start, length);
      state.cells[i][cp] = chars.join(''); return ok();
    },
    insertTextInCell(...args: [number, number, number, number, number, number, string]) {
      state.calls.push(['insert', ...args]);
      const [, , , i, cp, start, text] = args;
      const chars = Array.from(state.cells[i][cp]); chars.splice(start, 0, text);
      state.cells[i][cp] = chars.join(''); return ok();
    },
    insertPictureInParagraph(...args: Parameters<NonNullable<OperationDocument['insertPictureInParagraph']>>) {
      assert.equal(state.batch, false);
      state.events.push('picture'); state.calls.push(['picture', ...args]);
      const [, p, , , width, height, , , , description, props] = args;
      const positions = state.positions.get(p) || [];
      const ci = positions.length; positions.push(0); state.positions.set(p, positions);
      state.pictures.set(`${p}:${ci}`, { width, height, description, ...JSON.parse(props) });
      return json({ ok: true, paraIdx: p, controlIdx: ci });
    },
  };
  const wasm = {
    ...doc,
    getTableDimensions: () => ({ rowCount: 3, colCount: 4, cellCount: state.coords.length }),
    getCellInfo: (_s: number, _p: number, _c: number, i: number) => state.coords[i],
    insertTableRow: () => ({ ok: true }), deleteTableRow: () => ({ ok: true }),
    mergeTableCells: () => ({ ok: true }), getCellProperties: () => ({}),
    setCellProperties: () => ({ ok: true }), setFieldValueByName: () => ({ ok: true }),
  };
  const bridge = createOperationBridge({
    wasm: wasm as unknown as Parameters<typeof createOperationBridge>[0]['wasm'], rawDoc: () => doc,
    flushPendingNow: () => state.events.push('flush'), isExplicitBatchOpen: () => false,
    refreshDocumentView: () => state.events.push('refresh'), notifyChanged: () => state.events.push('changed'),
  });
  return { state, doc, wasm, ...bridge };
}

test('findTextMatch: scalar offsets, Zs/tab normalization, occurrence across paragraphs, literal regexp', () => {
  assert.equal(normalizeCellText('\u0085 A\u2007\tB\u001c'), 'A B');
  assert.equal(normalizeCellText('\ufeffA'), '\ufeffA');
  assert.deepEqual(findTextMatch(['😀 A\u2007\u2007B (인).*', 'A B'], 'A B'), [0, 2, 4]);
  assert.deepEqual(findTextMatch(['A B', '😀A\tB'], 'A B', 2), [1, 1, 3]);
  assert.deepEqual(findTextMatch(['😀(인).*'], '(인).*'), [0, 1, 5]);
  for (const value of ['', '  ', '\n', 'A\nB', undefined]) assert.equal(findTextMatch(['A B'], value), null);
  for (const occurrence of [0, -1, 1.5, NaN, 3]) assert.equal(findTextMatch(['A B'], 'A B', occurrence), null);
  assert.equal(findTextMatch(['A\nB'], 'A B'), null);
  assert.equal(findTextMatch(['A\ufeffB'], 'A B'), null);
});

test('cell paragraphs retain empty paragraphs', () => {
  const { doc } = fixture();
  assert.deepEqual(readCellParagraphs(doc, 0, 0, 0, 0), ['first', '']);
});

test('paragraph bbox unions charX runs and excludes cell text', () => {
  const { doc, state } = fixture();
  state.runs = [[cellRun({ x: 300 }), run({ text: '😀인', charX: [0, 7, 13] }),
    run({ text: ')', charStart: 2, x: 30, y: 35, charX: [0, 9] })]];
  assert.deepEqual(stampMatchBbox(doc, target, [0, 1, 2]), { page: 1, x: 17, y: 20, w: 22, h: 25 });
});

test('cell bbox requires identity, model row/col, one-level path and containment', () => {
  const { doc, state } = fixture();
  state.runs = [[run(), cellRun({ cellIdx: 0 }), cellRun({ cellParaIdx: 1 }),
    cellRun({ parentParaIdx: 1 }), cellRun({ controlIdx: 1 }), cellRun({ cellPath: [{}, {}] }),
    cellRun({ x: 500 }), cellRun({ x: 12 })]];
  assert.deepEqual(stampMatchBbox(doc, { ...target, kind: 'cell' }, [0, 0, 3]),
    { page: 1, x: 12, y: 20, w: 15, h: 10 });
  state.controls[0][0] = { ...table, cells: [] };
  assert.throws(() => stampMatchBbox(doc, { ...target, kind: 'cell' }, [0, 0, 3]), /stamp_anchor_not_found/);
});

test('partial page matches and missing/nonfinite charX refuse an anchor', () => {
  const { doc, state } = fixture();
  state.runs = [[run({ text: '(', charX: [0, 4] })], [run({ text: '인)', charStart: 1, charX: [0, 6, 11] })]];
  assert.throws(() => stampMatchBbox(doc, target, [0, 0, 3]), /stamp_anchor_not_found/);
  state.runs = [[run({ charX: [0, 4, 10, NaN] })]];
  assert.throws(() => stampMatchBbox(doc, target, [0, 0, 3]), /stamp_anchor_not_found/);
});

test('host paragraph prefers below table then left aligned, excludes controlled paragraphs; fallback', () => {
  const { doc, state } = fixture();
  const bbox = { page: 1, x: 10, y: 20, w: 15, h: 10 };
  state.runs = [[cellRun(), run({ paraIdx: 1, y: 120, x: 50 }),
    run({ paraIdx: 2, y: 140, x: 10 }), run({ paraIdx: 3, y: 5, x: 10 }),
    run({ paraIdx: 4, y: 111, x: 10 }), run({ paraIdx: 5, y: 112, x: 10, text: '  ' })]];
  state.positions.set(4, [0]);
  assert.equal(stampHostParagraph(doc, { ...target, kind: 'cell' }, bbox), 2);
  assert.equal(stampHostParagraph(doc, target, bbox), 0);
  state.positions.set(1, [0]); state.positions.set(2, [0]); state.positions.set(3, [0]);
  assert.equal(stampHostParagraph(doc, { ...target, kind: 'cell' }, bbox), 0);
});

test('batch paragraph replacement supports full soft-line snapshot, scalar positions and read-back', async () => {
  const f = fixture(); f.state.paragraphs[0] = '😀A\nB';
  const result = await f.applyOperationBatch([{ op: 'replaceMatchInParagraph', sec: 0, para: 0,
    find: { text: '😀A\nB', occurrence: 1 }, text: 'done', op_index: 42 }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied[0], { op_index: 42, op: 'replaceMatchInParagraph', status: 'APPLIED', detail: { ok: true }, error: null });
  assert.deepEqual(f.state.calls[0], ['replace', 0, 0, 0, 4, 'done']);
  assert.deepEqual(f.readTargets([{ kind: 'paragraph', sec: 0, para: 0 }]).targets[0],
    { kind: 'paragraph', sec: 0, para: 0, text: 'done' });
});

test('cell match uses shared row/col resolver, multiple paragraphs and original scalar length', async () => {
  const f = fixture();
  const result = await f.applyOperationBatch([{ op: 'replaceMatchInCell', sec: 0, para: 0, ci: 0,
    row: 2, col: 3, find: { text: 'A B' }, text: '완료' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(f.state.calls, [['delete', 0, 0, 0, 1, 1, 1, 4], ['insert', 0, 0, 0, 1, 1, 1, '완료']]);
  assert.equal(f.readTargets([{ kind: 'cell', sec: 0, para: 0, ci: 0, row: 2, col: 3 }]).targets[0].text, '(인)\n😀완료');
});

test('cell resolver invalidates after structural changes and rejects ambiguous coordinates', async () => {
  const f = fixture();
  const set = { op: 'setCellText', sec: 0, para: 0, ci: 0, row: 2, col: 3, text: 'first' };
  f.wasm.insertTableRow = () => { f.state.coords.reverse(); return { ok: true }; };
  const result = await f.applyOperationBatch([set, { op: 'insertTableRow', sec: 0, para: 0, ci: 0, row_idx: 0, below: true }, { ...set, text: 'second' }]);
  assert.equal(result.ok, true);
  assert.equal(f.state.cells[1][0], 'first'); assert.equal(f.state.cells[0][0], 'second');
  f.state.coords = [{ row: 2, col: 3 }, { row: 2, col: 3 }];
  const failed = await f.applyOperationBatch([{ ...set, op: 'replaceMatchInCell', find: { text: 'second' } }]);
  assert.equal(failed.applied[0].error, 'cell_not_found_by_row_col');
});

test('all failures stop later operations, preserve prior applied detail, and close the batch', async () => {
  const f = fixture();
  const op = { op: 'replaceMatchInParagraph', sec: 0, para: 0, find: { text: '(인)' }, text: 'done' };
  const result = await f.applyOperationBatch([op, op, { ...op, find: { text: 'done' }, text: 'never' }]);
  assert.equal(result.ok, false); assert.match(result.error!, /match_not_found/);
  assert.deepEqual(result.applied.map(x => x.status), ['APPLIED', 'ERROR']);
  assert.equal(f.state.paragraphs[0], 'done'); assert.equal(f.state.batch, false);
  assert.deepEqual(f.state.events.slice(-3), ['end', 'refresh', 'changed']);
});

test('stamp uses paper units outside batch; returns detail and paragraph picture read-back', async () => {
  const f = fixture(); const result = await f.applyOperationBatch([stamp()]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied[0].detail, { ok: true, controlIdx: 0, page: 1, host_para: 0,
    bbox_hwpunit: { x: 1016, y: 1673, w: 600, h: 400 },
    match_bbox_hwpunit: { x: 750, y: 1500, w: 1125, h: 750 } });
  const read = f.readTargets([{ kind: 'picture', sec: 0, para: 0, description: 'stamp-rule-1' }]).targets[0];
  assert.equal(read.picture_count, 1);
  assert.deepEqual(read.last_picture, { controlIdx: 0, width: 600, height: 400, treatAsChar: false,
    textWrap: 'InFrontOfText', vertRelTo: 'Paper', horzRelTo: 'Paper', vertAlign: 'Top', horzAlign: 'Left',
    vertOffset: 1673, horzOffset: 1016, description: 'stamp-rule-1' });
  assert.ok(f.state.events.indexOf('end') < f.state.events.indexOf('render:0'));
  assert.ok(f.state.events.indexOf('render:0') < f.state.events.indexOf('layout:0'));
  assert.equal(f.state.paragraphs.length, 3); assert.equal(f.state.paragraphs[0], '(인)');
});

test('cell stamp uses selected cell paragraph and plain body host; picture read-back falls back by description', async () => {
  const f = fixture(); f.state.cells[1][1] = '(인)';
  f.state.runs = [[cellRun({ cellParaIdx: 1 }), run({ paraIdx: 1, y: 120 })]];
  const result = await f.applyOperationBatch([stamp({ target: { ...target, kind: 'cell', cell_para_idx: 1 },
    placement: { mode: 'after_match', dx_hwpunit: 0, dy_hwpunit: 0 } })]);
  assert.equal(result.ok, true);
  assert.equal((result.applied[0].detail as any).host_para, 1);
  assert.equal((result.applied[0].detail as any).bbox_hwpunit.x, 1875);
  assert.deepEqual(f.state.calls[0].slice(0, 4), ['picture', 0, 1, 0]);
  const read = f.readTargets([{ kind: 'picture', sec: 0, para: 0, description: 'stamp-rule-1' },
    { kind: 'picture', sec: 0, para: 0, description: 'absent' }]).targets;
  assert.equal(read[0].picture_count, 1); assert.equal(read[1].picture_count, 0); assert.equal(read[1].last_picture, null);
});

test('image validation: png/jpg, exact 2 MiB limit, malformed base64/magic/extension/digest', async () => {
  assert.deepEqual(decodeStampImage(image()), new Uint8Array(png));
  assert.equal(decodeStampImage(image(Buffer.from('ffd8ff01', 'hex'), 'jpg')).length, 4);
  const limit = Buffer.alloc(2 * 1024 * 1024); png.copy(limit);
  assert.equal(decodeStampImage(image(limit)).length, limit.length);
  for (const bad of [image(Buffer.concat([limit, Buffer.from([0])])), image(png, 'jpeg'), image(Buffer.from('bad')),
    { ...image(), data_base64: '!!!!' }, { ...image(), data_base64: 'a===' }, { ...image(), data_base64: '' },
    { ...image(), data_base64: `${png.toString('base64')}\n` }, { ...image(), sha256: '0'.repeat(64) }]) {
    const f = fixture(); const result = await f.applyOperationBatch([stamp({ image: bad }), stamp()]);
    assert.equal(result.ok, false); assert.equal(result.applied[0].error, 'stamp_image_invalid');
    assert.equal(result.applied.length, 1); assert.equal(f.state.calls.length, 0); assert.equal(f.state.batch, false);
  }
});

test('stamp invalid target, anchor, sizes and legacy API preserve worker errors', async () => {
  const cases = [
    [stamp({ target: { ...target, kind: 'table' } }), 'stamp_target_invalid'],
    [stamp({ find: { text: 'absent' } }), 'match_not_found'],
    [stamp({ target: { ...target, kind: 'cell', cell_para_idx: 9 } }), 'stamp_anchor_not_found'],
    [stamp({ size: { width_hwpunit: 0, height_hwpunit: 400 } }), 'stamp_size_invalid'],
    [stamp({ placement: { mode: 'unknown', dx_hwpunit: 0, dy_hwpunit: 0 } }), 'stamp_size_invalid'],
    [stamp({ placement: { mode: 'over_match', dx_hwpunit: 2147483647, dy_hwpunit: 0 } }), 'stamp_size_invalid'],
    [stamp({ image: { ...image(), natural_width_px: 1.5 } }), 'stamp_size_invalid'],
  ] as const;
  for (const [op, error] of cases) {
    const f = fixture(); const result = await f.applyOperationBatch([op]);
    assert.equal(result.applied[0].error, error); assert.equal(f.state.calls.length, 0);
  }
  const f = fixture(); delete (f.doc as OperationDocument).insertPictureInParagraph;
  const result = await f.applyOperationBatch([stamp()]);
  assert.equal(result.applied[0].error, 'stamp_api_unavailable');
});

test('runtime paragraph insertion and host text mutation guards stop later ops', async () => {
  for (const mode of ['paragraph', 'text', 'paraIdx']) {
    const f = fixture();
    f.doc.insertPictureInParagraph = () => {
      if (mode === 'paragraph') f.state.paragraphs.push('unexpected');
      if (mode === 'text') f.state.paragraphs[0] = 'unexpected';
      return json({ ok: true, paraIdx: mode === 'paraIdx' ? 1 : 0, controlIdx: 0 });
    };
    const result = await f.applyOperationBatch([stamp(), stamp()]);
    assert.equal(result.ok, false); assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].error, mode === 'text' ? 'stamp_host_text_changed' : 'stamp_runtime_inserts_paragraphs');
    assert.equal(f.state.batch, false);
  }
});

test('begin/endBatch errors and malformed WASM results surface in batch results', async () => {
  const f = fixture(); f.doc.beginBatch = () => { throw new Error('begin broke'); };
  assert.match((await f.applyOperationBatch([])).error!, /beginBatch threw: begin broke/);
  const g = fixture(); g.doc.endBatch = () => { throw new Error('end broke'); };
  assert.match((await g.applyOperationBatch([])).error!, /endBatch threw: end broke/);
  const h = fixture(); h.doc.replaceText = () => 'null';
  const failed = await h.applyOperationBatch([{ op: 'replaceMatchInParagraph', sec: 0, para: 0, find: { text: '(인)' } }]);
  assert.match(failed.error!, /returned non-object JSON/);
});

test('unavailable SHA-256 cannot bypass validation when a caller omits the digest', async (t) => {
  t.mock.method(globalThis.crypto.subtle, 'digest', async () => { throw new Error('unavailable'); });
  const f = fixture();
  const result = await f.applyOperationBatch([stamp({ image: { ...image(), sha256: undefined } })]);
  assert.equal(result.applied[0].error, 'stamp_image_invalid');
  assert.equal(f.state.calls.length, 0);
});

test('multiple stamps remeasure outside batches, and paragraph anchors use scalar offsets', async () => {
  const f = fixture(); f.state.paragraphs[0] = '😀(인)';
  f.state.runs = [[run({ text: '😀(인)', charX: [0, 8, 12, 18, 23] })]];
  const result = await f.applyOperationBatch([stamp(), stamp()]);
  assert.equal(result.ok, true); assert.equal(result.applied.length, 2);
  assert.equal(f.state.calls[0][3], 1); assert.equal(f.state.calls[1][3], 1);
  assert.equal(f.state.events.filter(e => e === 'render:0').length, 2);
  const read = f.readTargets([{ kind: 'picture', sec: 0, para: 0, description: 'stamp-rule-1' }]).targets[0];
  assert.equal(read.picture_count, 2); assert.equal((read.last_picture as any).controlIdx, 1);
});

test('stamp natural dimensions match the worker 4096px limit without calling WASM on error', async () => {
  for (const dimension of ['natural_width_px', 'natural_height_px']) {
    for (const value of [0, 4097, 2147483647, 4294967295]) {
      const f = fixture();
      const result = await f.applyOperationBatch([stamp({ image: { ...image(), [dimension]: value } })]);
      assert.equal(result.ok, false);
      assert.equal(result.applied[0].error, 'stamp_size_invalid');
      assert.equal(f.state.calls.length, 0);
    }
  }
  const f = fixture();
  const result = await f.applyOperationBatch([stamp({ image: { ...image(), natural_width_px: 4096, natural_height_px: 4096 } })]);
  assert.equal(result.ok, true);
  assert.equal(f.state.calls.length, 1);
});

test('negative absolute placement is clamped onto the paper (worker policy) and reported', async () => {
  for (const placement of [
    { mode: 'over_match', dx_hwpunit: -200000, dy_hwpunit: 0 },
    { mode: 'over_match', dx_hwpunit: 0, dy_hwpunit: -200000 },
  ]) {
    const f = fixture();
    const result = await f.applyOperationBatch([stamp({ placement })]);
    assert.equal(result.ok, true);
    assert.equal(f.state.calls.length, 1);
    const props = JSON.parse(String(f.state.calls[0].at(-1)));
    assert.ok(props.horzOffset >= 0 && props.vertOffset >= 0);
    assert.equal(result.applied[0].detail.clamped_to_paper, true);
  }
});

test('native E_INVALID errors propagate through the operation bridge', async () => {
  const f = fixture();
  f.doc.insertPictureInParagraph = () => { throw new Error('E_INVALID: picture offset'); };
  const result = await f.applyOperationBatch([stamp()]);
  assert.equal(result.ok, false);
  assert.match(String(result.applied[0].error), /E_INVALID/);
});

/** Canonical HTATIS operation adapter. Raw WASM JSON contracts mirror the HTATIS Node worker
 * (aiblue-htatis-backend `rhwp_node/worker.cjs`). Keep this module independent of the editor
 * DOM so fixtures can exercise the bridge.
 */
import type { HwpDocument } from '@wasm/rhwp.js';
import type { WasmBridge } from './core/wasm-bridge';

export type OperationDocument = Pick<HwpDocument,
  'beginBatch' | 'endBatch' | 'pageCount' | 'renderPageSvg' | 'getPageTextLayout'
  | 'getPageControlLayout' | 'getCellInfo' | 'getParagraphCount' | 'getParagraphLength'
  | 'getTextRange' | 'getCellParagraphCount' | 'getCellParagraphLength' | 'getTextInCell'
  | 'getControlTextPositions' | 'getPictureProperties' | 'replaceText'
  | 'deleteTextInCell' | 'insertTextInCell'> & {
  insertPictureInParagraph?: (sec: number, para: number, offset: number, bytes: Uint8Array,
    width: number, height: number, naturalWidth: number, naturalHeight: number,
    extension: string, description: string, properties: string) => string;
};
interface MatchTarget {
  kind: string; sec: number; para: number; ci: number; cell_index: number; cell_para_idx: number;
  description?: string;
}
interface StampOperation {
  target?: MatchTarget;
  find?: { text: string; occurrence?: number };
  image?: { data_base64: string; extension: string; sha256: string;
    natural_width_px: number; natural_height_px: number };
  size?: { width_hwpunit: number; height_hwpunit: number };
  placement?: { mode: string; dx_hwpunit: number; dy_hwpunit: number };
  description: string;
}
type TextMatch = [number, number, number];
interface Box { x: number; y: number; w: number; h: number }
interface PageBox extends Box { page: number }
interface LayoutRun extends Box {
  secIdx: number; paraIdx: number; parentParaIdx?: number; controlIdx?: number;
  cellIdx?: number; cellParaIdx?: number; cellPath?: unknown[];
  charStart: number; text?: string; charX?: number[];
}
interface LayoutControl extends Box {
  type: string; secIdx: number; paraIdx: number; controlIdx: number;
  cells?: (Box & { row: number; col: number })[];
}
interface LayoutJSON { runs?: LayoutRun[]; controls?: LayoutControl[] }
function parseJsonObject<T = Record<string, unknown>>(raw: string, label: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${operationError(error)}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned non-object JSON`);
  }
  return parsed as T;
}
type FlatOperation = Record<string, unknown>;
type OperationStatus = 'APPLIED' | 'ERROR';

interface AppliedOperation {
  op_index: number;
  op: string;
  status: OperationStatus;
  detail: unknown;
  error: string | null;
}

interface OperationBatchResult {
  ok: boolean;
  error?: string;
  applied: AppliedOperation[];
  warnings: string[];
}

type CellCoordinates = Map<string, number[]>;

const SUPPORTED_OPERATIONS = new Set([
  'setCellText', 'replaceTextInCell', 'insertTableRow', 'deleteTableRow',
  'mergeTableCells', 'copyCellFormat', 'setFieldValueByName',
  'replaceMatchInParagraph', 'replaceMatchInCell', 'insertPictureAtMatch',
]);

const STRUCTURE_OPERATIONS = new Set([
  'insertTableRow',
  'deleteTableRow',
  'mergeTableCells',
]);

function operationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestedOpIndex(operation: FlatOperation, fallback: number): number {
  return typeof operation.op_index === 'number' ? operation.op_index : fallback;
}

function positiveCount(operation: FlatOperation, tag: string): number {
  const count = operation.count === undefined ? 1 : operation.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    throw new Error(`${tag} count must be a positive integer`);
  }
  return count;
}

function parseOkResult(raw: string, label: string): Record<string, unknown> {
  const parsed = parseJsonObject(raw, label);
  if (parsed.ok !== true) {
    throw new Error(`${label} failed: ${raw}`);
  }
  return parsed;
}

function requireOkResult<T extends { ok: boolean }>(result: T, label: string): T {
  if (result.ok !== true) throw new Error(`${label} failed`);
  return result;
}

export function normalizeCellText(text: string) {
  // Python str.isspace/re \s, including NEL and excluding JavaScript's BOM.
  return text.replace(/[ \t\n\r\v\f\u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ')
    .replace(/^ +| +$/g, '');
}

export function findTextMatch(paragraphs: string[], text: unknown, occurrence = 1): TextMatch | null {
  if (typeof text !== 'string' || !normalizeCellText(text) || !Number.isInteger(occurrence) ||
      occurrence < 1 || /[\r\n]/.test(text)) return null;
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode Zs spaces (HWP forms use U+2007 FIGURE SPACE etc.) + tab; keep equal to compiler.py _MATCH_SPACE_CLASS.
  const pattern = text.split(/[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/).map(escape).join('[ \\t\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]+');
  let remaining = occurrence;
  for (let index = 0; index < paragraphs.length; index++) {
    for (const match of paragraphs[index].matchAll(new RegExp(pattern, 'gu'))) {
      if (--remaining === 0) {
        // RHWP offsets count Unicode scalar values, not JavaScript UTF-16 units.
        return [index, Array.from(paragraphs[index].slice(0, match.index)).length,
          Array.from(match[0]).length];
      }
    }
  }
  return null;
}

export function readCellParagraphs(doc: Pick<OperationDocument, 'getCellParagraphCount' | 'getCellParagraphLength' | 'getTextInCell'>, sec: number, para: number, ci: number, cellIndex: number) {
  const count = doc.getCellParagraphCount(sec, para, ci, cellIndex);
  return Array.from({ length: count }, (_, index) => {
    const length = doc.getCellParagraphLength(sec, para, ci, cellIndex, index);
    return length ? (doc.getTextInCell(sec, para, ci, cellIndex, index, 0, length) || '') : '';
  });
}

// Layout JSON uses render-tree CSS pixels at DEFAULT_DPI=96 (renderer/mod.rs:
// hwpunit_to_px = units * dpi / 7200). rendering.rs returns node.bbox directly;
// layout.rs passes paper_area={x:0,y:0,...} to picture layout. Text and cell
// bboxes already include page margins: Paper/Top/Left needs no added margin.
const STAMP_HWPUNIT_PER_LAYOUT_PX = 7200 / 96;
const STAMP_MAX_BYTES = 2 * 1024 * 1024;

export function stampMatchBbox(doc: OperationDocument, target: MatchTarget, match: TextMatch): PageBox {
  const start = match[1], end = start + match[2];
  const info = target.kind === 'cell'
    ? parseJsonObject<{ row: number; col: number }>(doc.getCellInfo(target.sec, target.para, target.ci, target.cell_index), 'stamp cell')
    : null;
  for (let pageIndex = 0; pageIndex < doc.pageCount(); pageIndex++) {
    const layout = parseJsonObject<LayoutJSON>(doc.getPageTextLayout(pageIndex), 'stamp text layout');
    let cellBox = null;
    if (info) {
      const controls = parseJsonObject<LayoutJSON>(doc.getPageControlLayout(pageIndex), 'stamp control layout');
      const table = (controls.controls || []).find(c => c.type === 'table'
        && c.secIdx === target.sec && c.paraIdx === target.para && c.controlIdx === target.ci);
      // Rendered cellIdx is a page-local ordinal, so use the model row/col.
      cellBox = table && (table.cells || []).find(c => c.row === info.row && c.col === info.col);
      if (!cellBox) continue;
    }
    const boxes: Box[] = [], covered = new Set<number>();
    for (const run of layout.runs || []) {
      if (run.secIdx !== target.sec || !Number.isInteger(run.charStart)) continue;
      if (target.kind === 'paragraph') {
        if (run.paraIdx !== target.para || run.parentParaIdx !== undefined || run.cellPath) continue;
      } else {
        if (run.parentParaIdx !== target.para || run.controlIdx !== target.ci
          || run.cellIdx !== target.cell_index || run.cellParaIdx !== target.cell_para_idx
          || (run.cellPath && run.cellPath.length !== 1)) continue;
        // Identity plus containment prevents overlapping body text from anchoring a cell stamp.
        if (run.x < cellBox!.x - 0.2 || run.x >= cellBox!.x + cellBox!.w
          || run.y < cellBox!.y - 0.2 || run.y >= cellBox!.y + cellBox!.h) continue;
      }
      const length = Array.from(run.text || '').length;
      const lo = Math.max(start, run.charStart), hi = Math.min(end, run.charStart + length);
      if (hi <= lo || !Array.isArray(run.charX)) continue;
      const left = run.charX[lo - run.charStart], right = run.charX[hi - run.charStart];
      if (![left, right, run.x, run.y, run.h].every(Number.isFinite)) continue;
      boxes.push({x: run.x + left, y: run.y, w: right - left, h: run.h});
      for (let char = lo; char < hi; char++) covered.add(char);
    }
    // Refuse partial anchors (e.g. a match split over two pages).
    if (covered.size !== match[2] || !boxes.length) continue;
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    return {page: pageIndex + 1, x, y,
      w: Math.max(...boxes.map(b => b.x + b.w)) - x,
      h: Math.max(...boxes.map(b => b.y + b.h)) - y};
  }
  throw new Error('stamp_anchor_not_found');
}

// A floating picture attached to the paragraph that hosts a treat-as-char table shifted a
// centred signature table sideways in rhwp's layout (울산 제4호, 2026-09-14). For cell
// anchors, host the picture in a plain body paragraph on the same page instead: the stamp is
// positioned Paper-relative, so the host only decides the page it belongs to.
export function stampHostParagraph(doc: OperationDocument, target: MatchTarget, bbox: PageBox): number {
  if (target.kind !== 'cell') return target.para;
  const pageIndex = bbox.page - 1;
  const layout = parseJsonObject<LayoutJSON>(doc.getPageTextLayout(pageIndex), 'stamp host layout');
  const controls = parseJsonObject<LayoutJSON>(doc.getPageControlLayout(pageIndex), 'stamp host controls');
  const table = (controls.controls || []).find(c => c.type === 'table'
    && c.secIdx === target.sec && c.paraIdx === target.para && c.controlIdx === target.ci);
  const tableTop = table ? table.y : bbox.y, tableBottom = table ? table.y + table.h : bbox.y + bbox.h;
  const paragraphs = new Map<number, { para: number; x: number; y: number }>();
  let leftEdge = Infinity;
  for (const run of layout.runs || []) {
    if (run.secIdx !== target.sec || run.parentParaIdx !== undefined || run.cellPath) continue;
    if (!Number.isInteger(run.paraIdx) || run.paraIdx === target.para || !(run.text || '').trim()) continue;
    if (Number.isFinite(run.x)) leftEdge = Math.min(leftEdge, run.x);
    const entry = paragraphs.get(run.paraIdx) || {para: run.paraIdx, y: run.y, x: run.x};
    if (run.y < entry.y) { entry.y = run.y; entry.x = run.x; }
    paragraphs.set(run.paraIdx, entry);
  }
  const candidates = [...paragraphs.values()].filter(entry => {
    try { return JSON.parse(doc.getControlTextPositions(target.sec, entry.para)).length === 0; }
    catch { return false; }
  });
  if (!candidates.length) return target.para;
  const score = (entry: { x: number; y: number }) => {
    const below = entry.y >= tableBottom - 0.5;
    const distance = below ? entry.y - tableBottom : Math.max(0, tableTop - entry.y);
    // Prefer paragraphs below the table, then left-aligned ones (centred lines could still
    // move if the layout counted the control), then the nearest.
    return (below ? 0 : 100000) + (Math.abs(entry.x - leftEdge) <= 2 ? 0 : 10000) + distance;
  };
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0].para;
}

export function insertPictureAtMatch(doc: OperationDocument, operation: StampOperation, imageDigest?: string) {
  if (typeof doc.insertPictureInParagraph !== 'function') throw new Error('stamp_api_unavailable');
  const {find, image, size, placement, description} = operation;
  const target = operation.target && {...operation.target, cell_para_idx: operation.target.cell_para_idx ?? 0};
  if (!target || !['paragraph', 'cell'].includes(target.kind)) throw new Error('stamp_target_invalid');
  const hostText = doc.getTextRange(target.sec, target.para, 0, doc.getParagraphLength(target.sec, target.para));
  const paragraphs = target.kind === 'cell'
    ? [readCellParagraphs(doc, target.sec, target.para, target.ci, target.cell_index)[target.cell_para_idx]]
    : [hostText];
  if (typeof paragraphs[0] !== 'string') throw new Error('stamp_anchor_not_found');
  const match = findTextMatch(paragraphs, find && find.text, find && find.occurrence);
  if (!match) throw new Error('match_not_found');
  const bbox = stampMatchBbox(doc, target, match);
  const bytes = decodeStampImage(image);
  if (!image || typeof imageDigest !== 'string' || imageDigest !== image.sha256) {
    throw new Error('stamp_image_invalid');
  }
  const width = size?.width_hwpunit as number, height = size?.height_hwpunit as number;
  if (![width, height].every(v => Number.isInteger(v) && v > 0 && v <= 2147483647)
    || ![image.natural_width_px, image.natural_height_px].every(v => Number.isInteger(v) && v > 0 && v <= 4096)
    || !placement || !['over_match', 'after_match'].includes(placement.mode)
    || ![placement.dx_hwpunit, placement.dy_hwpunit].every(v => Number.isInteger(v) && Math.abs(v) <= 2147483647)) {
    throw new Error('stamp_size_invalid');
  }
  const x = (bbox.x + (placement.mode === 'after_match' ? bbox.w : bbox.w / 2)) * STAMP_HWPUNIT_PER_LAYOUT_PX
    - (placement.mode === 'after_match' ? 0 : width / 2) + placement.dx_hwpunit;
  const y = (bbox.y + bbox.h / 2) * STAMP_HWPUNIT_PER_LAYOUT_PX - height / 2 + placement.dy_hwpunit;
  if (![x, y].every(v => Number.isFinite(v) && Math.abs(v) <= 2147483647)) throw new Error('stamp_size_invalid');
  // The HTATIS Node worker clamps a stamp hanging off the top/left paper edge onto the paper;
  // the preview keeps the same policy so both place the stamp alike, and reports it.
  const clampedToPaper = x < 0 || y < 0;
  const px = Math.max(0, x), py = Math.max(0, y);
  const paragraphCount = doc.getParagraphCount(target.sec);
  // getTextRange/findTextMatch use Unicode scalar indices into para.text.
  // object_ops/picture.rs::insert_picture_in_paragraph_native maps that index through
  // para.char_offsets, accounting for UTF-16 widths and 8-unit control gaps.
  // Cell anchors attach to a body paragraph on the same page (see stampHostParagraph) at index 0.
  const hostPara = stampHostParagraph(doc, target, bbox);
  const hostParaText = doc.getTextRange(target.sec, hostPara, 0, doc.getParagraphLength(target.sec, hostPara));
  const charOffset = target.kind === 'paragraph' ? match[1] : 0;
  const inserted = parseOkResult(doc.insertPictureInParagraph(target.sec, hostPara, charOffset, bytes,
    width, height, image.natural_width_px, image.natural_height_px, image.extension, description,
    JSON.stringify({
      treatAsChar: false, textWrap: 'InFrontOfText', vertRelTo: 'Paper', horzRelTo: 'Paper',
      vertAlign: 'Top', horzAlign: 'Left', vertOffset: Math.round(py), horzOffset: Math.round(px),
    })), 'insertPictureInParagraph');
  // Defend against incompatible runtimes before exporting or applying later ops.
  if (inserted.paraIdx !== hostPara || doc.getParagraphCount(target.sec) !== paragraphCount) {
    throw new Error('stamp_runtime_inserts_paragraphs');
  }
  if (doc.getTextRange(target.sec, hostPara, 0, doc.getParagraphLength(target.sec, hostPara)) !== hostParaText
    || doc.getTextRange(target.sec, target.para, 0, doc.getParagraphLength(target.sec, target.para)) !== hostText) {
    throw new Error('stamp_host_text_changed');
  }
  return {ok: true, controlIdx: inserted.controlIdx, page: bbox.page, host_para: hostPara,
    ...(clampedToPaper ? {clamped_to_paper: true} : {}),
    bbox_hwpunit: {x: Math.round(px), y: Math.round(py), w: width, h: height},
    match_bbox_hwpunit: Object.fromEntries((['x', 'y', 'w', 'h'] as const).map(k => [k, bbox[k] * STAMP_HWPUNIT_PER_LAYOUT_PX]))};
}

function readPicturesIn(doc: OperationDocument, sec: number, para: number, description?: string) {
  const positions = JSON.parse(doc.getControlTextPositions(sec, para));
  const pictures = [];
  for (let ci = 0; ci < positions.length; ci++) {
    let props;
    try { props = parseJsonObject(doc.getPictureProperties(sec, para, ci), 'picture properties'); }
    catch { continue; } // Other controls in the same host paragraph are expected.
    if (description && props.description !== description) continue;
    const keys = ['width', 'height', 'treatAsChar', 'textWrap', 'vertRelTo', 'horzRelTo',
      'vertAlign', 'horzAlign', 'vertOffset', 'horzOffset', 'description'];
    pictures.push({controlIdx: ci, ...Object.fromEntries(keys.map(key => [key, props[key]]))});
  }
  return pictures;
}

export function readPictures(doc: OperationDocument, target: FlatOperation) {
  let pictures = readPicturesIn(doc, target.sec as number, target.para as number, target.description as string | undefined);
  if (!pictures.length && target.description) {
    // Cell-anchored stamps are hosted in a nearby body paragraph (stampHostParagraph);
    // the description is unique per rule, so locate it anywhere in the section.
    const count = doc.getParagraphCount(target.sec as number);
    for (let para = 0; para < count && !pictures.length; para++) {
      if (para === target.para) continue;
      pictures = readPicturesIn(doc, target.sec as number, para, target.description as string);
    }
  }
  return {...target, picture_count: pictures.length, last_picture: pictures.at(-1) || null};
}

export function decodeStampImage(image: StampOperation['image']): Uint8Array<ArrayBuffer> {
  // Bound allocation before decoding; this is the same 2 MiB decoded limit as the worker.
  if (!image || typeof image.data_base64 !== 'string'
    || image.data_base64.length > Math.ceil(STAMP_MAX_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data_base64)) {
    throw new Error('stamp_image_invalid');
  }
  const bytes = Uint8Array.from(atob(image.data_base64), char => char.charCodeAt(0));
  const magic = image.extension === 'png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    : image.extension === 'jpg' ? [0xff, 0xd8, 0xff] : null;
  if (!magic || !bytes.length || bytes.length > STAMP_MAX_BYTES
    || !magic.every((value, index) => bytes[index] === value)) throw new Error('stamp_image_invalid');
  return bytes;
}

async function stampImageDigest(operation: FlatOperation): Promise<string | undefined> {
  if (operation.op !== 'insertPictureAtMatch') return undefined;
  try {
    const bytes = decodeStampImage((operation as unknown as StampOperation).image);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // Validate at the op's position, preserving worker error order and prior applied ops.
    return undefined;
  }
}

export function createOperationBridge({ wasm, rawDoc, flushPendingNow, isExplicitBatchOpen,
  refreshDocumentView, notifyChanged }: {
  wasm: Pick<WasmBridge, 'getTableDimensions' | 'getCellInfo' | 'getCellParagraphCount'
    | 'getCellParagraphLength' | 'deleteTextInCell' | 'insertTextInCell' | 'insertTableRow'
    | 'deleteTableRow' | 'mergeTableCells' | 'getCellProperties' | 'setCellProperties' | 'setFieldValueByName'>;
  rawDoc: () => OperationDocument | null;
  flushPendingNow: () => void;
  isExplicitBatchOpen: () => boolean;
  refreshDocumentView: () => void;
  notifyChanged: () => void;
}) {
  function createCellIndexResolver() {
    const cache = new Map<string, CellCoordinates>();
    const tableKey = (sec: number, para: number, ci: number) => `${sec}:${para}:${ci}`;
    const coordinateKey = (row: number, col: number) => `${row}:${col}`;

    function build(sec: number, para: number, ci: number): CellCoordinates {
      const dimensions = wasm.getTableDimensions(sec, para, ci);
      const coordinates: CellCoordinates = new Map();
      for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex++) {
        const info = wasm.getCellInfo(sec, para, ci, cellIndex);
        if (!Number.isInteger(info.row) || !Number.isInteger(info.col)) continue;
        const key = coordinateKey(info.row, info.col);
        const matches = coordinates.get(key) ?? [];
        matches.push(cellIndex);
        coordinates.set(key, matches);
      }
      cache.set(tableKey(sec, para, ci), coordinates);
      return coordinates;
    }

    return {
      resolve(sec: number, para: number, ci: number, row: number, col: number): number {
        const key = tableKey(sec, para, ci);
        const coordinates = cache.get(key) ?? build(sec, para, ci);
        const matches = coordinates.get(coordinateKey(row, col)) ?? [];
        if (matches.length !== 1) throw new Error('cell_not_found_by_row_col');
        return matches[0];
      },
      invalidate(sec: number, para: number, ci: number): void {
        cache.delete(tableKey(sec, para, ci));
      },
    };
  }

  type CellIndexResolver = ReturnType<typeof createCellIndexResolver>;

  function resolveOperationCellIndex(
    operation: FlatOperation,
    resolver: CellIndexResolver,
    indexKey = 'cell_index',
  ): number {
    const cellIndex = operation[indexKey];
    if (typeof cellIndex === 'number' && Number.isInteger(cellIndex) && cellIndex >= 0) {
      return cellIndex;
    }
    const { sec, para, ci, row, col } = operation;
    if (
      typeof row === 'number' && Number.isInteger(row) && row >= 0
      && typeof col === 'number' && Number.isInteger(col) && col >= 0
    ) {
      return resolver.resolve(sec as number, para as number, ci as number, row, col);
    }
    throw new Error('cell_not_found_by_row_col');
  }

  function applyOperation(
    operation: FlatOperation,
    tag: string,
    warnings: string[],
    cellIndexResolver: CellIndexResolver,
    doc: OperationDocument,
    imageDigest?: string,
  ): unknown {
    const op = operation.op;
    const sec = operation.sec as number;
    const para = operation.para as number;
    const ci = operation.ci as number;

    if (op === 'insertPictureAtMatch') return insertPictureAtMatch(doc, operation as unknown as StampOperation, imageDigest);
    if (op === 'replaceMatchInParagraph') {
      const { sec, para, find, text = '' } = operation as unknown as { sec: number; para: number; find?: { text: string; occurrence?: number }; text?: unknown };
      const original = doc.getTextRange(sec, para, 0, doc.getParagraphLength(sec, para));
      // The compiler encodes replace_paragraph as an exact snapshot of the full
      // paragraph. This also supports soft line breaks within that paragraph.
      const match = find && normalizeCellText(original) && find.text === original && find.occurrence === 1
        ? [0, 0, Array.from(original).length]
        : findTextMatch([original], find && find.text, find && find.occurrence);
      if (!match) throw new Error('match_not_found');
      return parseOkResult(doc.replaceText(sec, para, match[1], match[2], String(text)),
        `${tag} replaceText`);
    }
    if (op === 'replaceMatchInCell') {
      const { find, text = '' } = operation as { find?: { text: string; occurrence?: number }; text?: unknown };
      const cellIndex = resolveOperationCellIndex(operation, cellIndexResolver);
      const paragraphs = readCellParagraphs(doc, sec, para, ci, cellIndex);
      const match = findTextMatch(paragraphs, find && find.text, find && find.occurrence);
      if (!match) throw new Error('match_not_found');
      const [cellPara, offset, length] = match;
      const deleted = parseOkResult(
        doc.deleteTextInCell(sec, para, ci, cellIndex, cellPara, offset, length), `${tag} deleteTextInCell`);
      const inserted = parseOkResult(
        doc.insertTextInCell(sec, para, ci, cellIndex, cellPara, offset, String(text)), `${tag} insertTextInCell`);
      return { deleted, inserted };
    }
    if (op === 'setCellText') {
      const cellIndex = resolveOperationCellIndex(operation, cellIndexResolver);
      const paragraphCount = wasm.getCellParagraphCount(sec, para, ci, cellIndex);
      if (paragraphCount > 1) {
        warnings.push(`${tag} setCellText replaced paragraph 0 only (${paragraphCount} paragraphs)`);
      }
      const length = wasm.getCellParagraphLength(sec, para, ci, cellIndex, 0);
      parseOkResult(
        wasm.deleteTextInCell(sec, para, ci, cellIndex, 0, 0, length),
        `${tag} deleteTextInCell`,
      );
      parseOkResult(
        wasm.insertTextInCell(sec, para, ci, cellIndex, 0, 0, String(operation.text ?? '')),
        `${tag} insertTextInCell`,
      );
      return;
    }

    if (op === 'replaceTextInCell') {
      const cellIndex = resolveOperationCellIndex(operation, cellIndexResolver);
      const cellParaIdx = operation.cell_para_idx as number;
      const charOffset = operation.char_offset as number;
      const length = operation.length as number;
      parseOkResult(
        wasm.deleteTextInCell(sec, para, ci, cellIndex, cellParaIdx, charOffset, length),
        `${tag} deleteTextInCell`,
      );
      parseOkResult(
        wasm.insertTextInCell(
          sec,
          para,
          ci,
          cellIndex,
          cellParaIdx,
          charOffset,
          String(operation.text ?? ''),
        ),
        `${tag} insertTextInCell`,
      );
      return;
    }

    if (op === 'insertTableRow') {
      if (typeof operation.below !== 'boolean') {
        throw new Error(`${tag} below must be boolean`);
      }
      const count = positiveCount(operation, tag);
      for (let n = 0; n < count; n++) {
        requireOkResult(
          wasm.insertTableRow(sec, para, ci, operation.row_idx as number, operation.below),
          `${tag} insertTableRow`,
        );
      }
      return;
    }

    if (op === 'deleteTableRow') {
      const rowIdx = operation.row_idx as number;
      const count = positiveCount(operation, tag);
      for (let index = rowIdx + count - 1; index >= rowIdx; index--) {
        requireOkResult(wasm.deleteTableRow(sec, para, ci, index), `${tag} deleteTableRow`);
      }
      return;
    }

    if (op === 'mergeTableCells') {
      requireOkResult(
        wasm.mergeTableCells(
          sec,
          para,
          ci,
          operation.start_row as number,
          operation.start_col as number,
          operation.end_row as number,
          operation.end_col as number,
        ),
        `${tag} mergeTableCells`,
      );
      return;
    }

    if (op === 'copyCellFormat') {
      const sourceCellIndex = operation.source_cell_index as number;
      const targetCellIndex = resolveOperationCellIndex(
        operation,
        cellIndexResolver,
        'target_cell_index',
      );
      const sourceProperties = wasm.getCellProperties(sec, para, ci, sourceCellIndex);
      requireOkResult(
        wasm.setCellProperties(sec, para, ci, targetCellIndex, sourceProperties),
        `${tag} setCellProperties`,
      );
      return;
    }

    if (op === 'setFieldValueByName') {
      requireOkResult(
        wasm.setFieldValueByName(operation.field_name as string, String(operation.text ?? '')),
        `${tag} setFieldValueByName`,
      );
      return;
    }

    throw new Error(`${tag} unsupported op: ${String(op)}`);
  }

  async function applyOperationBatch(operations: unknown): Promise<OperationBatchResult> {
    const applied: AppliedOperation[] = [];
    const warnings: string[] = [];
    const fail = (error: string): OperationBatchResult => ({ ok: false, error, applied, warnings });
    if (!Array.isArray(operations)) return fail('operations must be an array');
    if (isExplicitBatchOpen()) return fail('applyOperationBatch cannot run inside an explicit batch');
    const ops = operations.map(operation => operation && typeof operation === 'object'
      ? operation as FlatOperation : {});
    // Hash before opening a WASM batch. No await occurs while applying document mutations.
    const digests: (string | undefined)[] = [];
    for (const operation of ops) digests.push(await stampImageDigest(operation));
    flushPendingNow();
    const doc = rawDoc();
    if (!doc) return fail('document is not loaded');
    const cellIndexResolver = createCellIndexResolver();
    let error: string | undefined;
    let batchOpen = false;
    try { doc.beginBatch(); batchOpen = true; }
    catch (cause) { return fail(`beginBatch threw: ${operationError(cause)}`); }
    try {
      for (let index = 0; index < ops.length; index++) {
        const operation = ops[index];
        const opIndex = requestedOpIndex(operation, index);
        const op = typeof operation.op === 'string' ? operation.op : '';
        const tag = `operations[${index}]`;
        try {
          if (!SUPPORTED_OPERATIONS.has(op)) throw new Error(`${tag} unsupported op: ${op}`);
          let detail: unknown;
          if (op === 'insertPictureAtMatch') {
            doc.endBatch();
            batchOpen = false;
            // The browser must retain the editor's document instance. Force layout without
            // export/reload; table-cell page splitting can still be stale in some runtimes.
            for (let page = 0; page < doc.pageCount(); page++) doc.renderPageSvg(page);
            detail = applyOperation(operation, tag, warnings, cellIndexResolver, doc, digests[index]);
            doc.beginBatch();
            batchOpen = true;
          } else {
            detail = applyOperation(operation, tag, warnings, cellIndexResolver, doc);
          }
          if (STRUCTURE_OPERATIONS.has(op)) {
            cellIndexResolver.invalidate(operation.sec as number, operation.para as number, operation.ci as number);
          }
          applied.push({ op_index: opIndex, op, status: 'APPLIED', detail: detail ?? null, error: null });
        } catch (cause) {
          const reason = operationError(cause);
          applied.push({ op_index: opIndex, op, status: 'ERROR', detail: null, error: reason });
          error = `${tag} ${op} failed: ${reason}`;
          break;
        }
      }
    } finally {
      if (batchOpen) {
        try { doc.endBatch(); }
        catch (cause) {
          const reason = `endBatch threw: ${operationError(cause)}`;
          if (error) warnings.push(reason);
          else error = reason;
        }
      }
    }
    try { refreshDocumentView(); }
    catch (cause) { warnings.push(`refreshDocumentView failed: ${operationError(cause)}`); }
    try { notifyChanged(); }
    catch (cause) { warnings.push(`document-changed notification failed: ${operationError(cause)}`); }
    return error ? fail(error) : { ok: true, applied, warnings };
  }

  function readTargets(targets: unknown): { ok: true; targets: FlatOperation[] } {
    if (!Array.isArray(targets)) throw new Error('targets must be an array');
    flushPendingNow();
    const result: FlatOperation[] = [];
    const doc = rawDoc();
    if (!doc) throw new Error('document is not loaded');
    const cellIndexResolver = createCellIndexResolver();

    for (let index = 0; index < targets.length; index++) {
      const target = targets[index] && typeof targets[index] === 'object'
        ? targets[index] as FlatOperation
        : {};
      const sec = target.sec as number;
      const para = target.para as number;
      const ci = target.ci as number;
      if (target.kind === 'paragraph') {
        result.push({ ...target, text: doc.getTextRange(sec, para, 0, doc.getParagraphLength(sec, para)) });
      } else if (target.kind === 'picture') {
        result.push(readPictures(doc, target));
      } else if (target.kind === 'cell') {
        const cellIndex = resolveOperationCellIndex(target, cellIndexResolver);
        const paragraphs = readCellParagraphs(doc, sec, para, ci, cellIndex);
        result.push({ ...target, text: paragraphs.join('\n') });
      } else if (target.kind === 'table') {
        const dimensions = wasm.getTableDimensions(sec, para, ci);
        result.push({
          ...target,
          row_count: dimensions.rowCount,
          col_count: dimensions.colCount,
        });
      } else {
        throw new Error(`targets[${index}] unsupported kind: ${String(target.kind)}`);
      }
    }
    return { ok: true, targets: result };
  }


  return { applyOperationBatch, readTargets };
}

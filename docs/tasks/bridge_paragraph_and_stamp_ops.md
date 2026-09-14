# rhwp-studio 브리지 — HTATIS doc-ops 신규 op 지원 (문단 치환·셀 매치 치환·도장 삽입·문단/그림 read_targets)

배경: HTATIS 양식 작성의 "실시간 자동작성" 미리보기는 브라우저의 rhwp-studio 브리지(`rhwp-studio/src/rhwp-api-bridge.ts`, `applyOperationBatch`/`readTargets`)가 백엔드가 컴파일한 flat op 배치를 그대로 재생한다. 백엔드 Node 워커(`/Users/aiblue/.paseo/worktrees/1428ddiu/impolite-yak/rhwp_node/worker.cjs`, 읽기 전용 참조)에는 PR-53/56 으로 op 가 추가됐지만 브리지는 모른다 → 미리보기가 `미리보기에 실패해 원본으로 돌아왔습니다` 로 떨어진다. 브리지에 같은 op 를 같은 의미로 구현한다. 커밋 금지. 완료 후 이 문서 끝에 `## codex 구현 메모`.

## 구현 대상 (worker.cjs 의 함수를 TS 로 옮긴다 — 의미·오류 코드·반환 형태 동일)
1. 공통: `normalizeCellText`, `findTextMatch(paragraphs, text, occurrence)`(유니코드 Zs 공백 정규화 매치, 원본 문자열 기준 [paraIdx, start, len] 반환), `readCellParagraphs(doc, sec, para, ci, cellIndex)`.
2. op `replaceMatchInParagraph {sec, para, find{text, occurrence}, text}` → `replaceText(sec, para, start, len, text)`; `replaceMatchInCell {sec, para, ci, cell_index|row/col, find, text}` → `deleteTextInCell` + `insertTextInCell`(셀 인덱스 해석은 기존 `setCellText` 경로와 같은 resolver 사용).
3. op `insertPictureAtMatch {target:{kind:'paragraph'|'cell', sec, para, ci?, cell_index?, cell_para_idx?}, find, image{data_base64, extension, natural_width_px, natural_height_px, sha256}, size{width_hwpunit, height_hwpunit}, placement{mode:'over_match'|'after_match', dx_hwpunit, dy_hwpunit}, description}`: worker.cjs 의 `stampMatchBbox`(페이지 텍스트 레이아웃 run 의 charX 로 매치 bbox 측정, 셀 타깃은 표 셀 bbox 안 run 만), `stampHostParagraph`(셀 타깃은 같은 쪽의 컨트롤 없는 본문 문단에 호스팅 — 표 아래·왼쪽 정렬 우선), `insertPictureAtMatch`(`insertPictureInParagraph(..., JSON.stringify({treatAsChar:false, textWrap:'InFrontOfText', vertRelTo:'Paper', horzRelTo:'Paper', vertAlign:'Top', horzAlign:'Left', vertOffset, horzOffset}))`, 문단 수·호스트 텍스트 보존 방어, 반환 `{ok, controlIdx, page, host_para, bbox_hwpunit, match_bbox_hwpunit}`)를 그대로 옮긴다. 좌표 계수 `STAMP_HWPUNIT_PER_LAYOUT_PX = 7200/96`. 워커는 첫 도장 op 전에 `endBatch → exportHwp → 재로드` 로 최종 쪽 나눔을 확보한다 — 브라우저에서는 문서를 다시 로드하면 편집기 상태가 깨지므로, 대신 `endBatch()` 후 `pageCount()`/`getPageSvg` 등 레이아웃을 강제하는 호출을 시도하고, 그래도 쪽 나눔이 안 맞는 경우가 있다는 것을 메모에 남긴다(원인: 메모리 편집 상태의 표 칸 쪽 넘김 미갱신). `insertPictureInParagraph` 가 없는 구형 wasm 이면 `stamp_api_unavailable`.
4. `readTargets` 에 kind `paragraph`(문단 텍스트 read-back, worker 와 같은 응답)와 kind `picture`(`readPictures`: 대상 문단의 그림 컨트롤 중 description 일치 → 없으면 구역 전체를 description 으로 탐색; `{...target, picture_count, last_picture}`)를 추가한다.
5. 브리지의 지원 op 목록(`applyOperationBatch` 의 허용 목록, ~206행)과 capabilities 보고(있다면)에 새 op 를 추가한다. 배치는 워커처럼 실패 시 이후 op 를 중단하고 `{ok:false, error, applied, warnings}` 를 돌려준다.
6. 이미지 유효성: base64·확장자(png/jpg magic)·2 MB 상한·sha256 일치 검사는 워커와 동일.

## 검증
- `rhwp-studio` 의 기존 테스트 러너(`package.json` scripts 확인: vitest 등)로 `findTextMatch`·매치 좌표 계산·호스트 문단 선택 순수 함수 단위 테스트를 추가한다(레이아웃 run/컨트롤 JSON 을 픽스처로). wasm 이 필요한 경로는 브리지 함수를 mock 문서 객체로 테스트한다.
- `npx tsc --noEmit -p rhwp-studio`(또는 프로젝트의 타입검사 명령)와 `npx vite build`(rhwp-studio) 통과. 실제 브라우저 검증은 Claude 가 HTATIS FE 로 수행한다.


## codex 구현 메모

- 구현일: 2026-09-14. 커밋하지 않았다. 워커 참조 파일은 읽기만 했으며 기존 Rust/WASM 소스 및 다른 작업자의 변경은 수정하지 않았다.
- `rhwp-studio/src/rhwp-operation-batch.ts`로 기존 배치/타깃 조회를 분리하고 `normalizeCellText`, `findTextMatch`, `readCellParagraphs`, 문단·셀 매치 치환, 도장 bbox/호스트 선택/삽입, paragraph/picture read-back을 구현했다. 기존 셀 op와 신규 셀 매치 op는 동일한 row/col resolver를 사용한다.
- 매치는 Unicode scalar 기준 원본 오프셋을 반환한다. Zs/탭 정규화, occurrence, 정규식 문자 이스케이프, 전체 문단 스냅샷의 소프트 줄바꿈 치환을 워커와 맞췄다.
- 도장은 charX와 셀 식별자·row/col bbox 포함 여부를 검사하며, 여러 쪽에 걸쳐 일부만 발견한 앵커는 거부한다. 셀 도장은 같은 쪽의 컨트롤 없는 본문 문단 중 표 아래·왼쪽 정렬·가까운 문단을 우선한다. 후보가 없으면 워커처럼 표 호스트 문단을 사용한다.
- 그림은 `insertPictureInParagraph`에 Paper/Top/Left, InFrontOfText 속성과 7200/96 좌표 계수를 적용한다. 문단 수, 반환 paraIdx, 호스트/타깃 텍스트 보존을 검사하며 도장 상세 반환값은 `applied[].detail`에 담는다. 그림 read-back은 요청 문단에서 찾지 못했을 때 description으로 같은 구역을 탐색한다.
- base64 형식, png/jpg magic, 디코딩 후 2 MiB 상한, SHA-256, 크기와 오프셋 범위를 검증한다. Web Crypto SHA-256은 WASM 배치 시작 전에 계산하고, 이후 문서 변경은 동기적으로 수행한다. postMessage 요청은 직렬화해 hash 대기 중 read-back/load/restore가 배치를 추월하지 않게 했다. `main.ts` 순환 import는 첫 요청 시 지연 초기화로 처리했다.
- 지원 op 목록에 신규 3종을 추가했다. 별도 capabilities 응답은 기존 브리지에 없어 추가하지 않았다. 배치 항목은 워커 형태인 `{op_index, op, status: 'APPLIED'|'ERROR', detail, error}`를 사용한다. 작업 문서 5번에 따라 모든 op 실패 시 즉시 후속 op를 중단하고 `{ok:false, error, applied, warnings}`를 반환한다. 참고로 읽은 워커 버전은 구조/도장 실패에만 break하지만, 여기서는 작업 문서의 더 엄격한 중단 조건을 적용했다. 이미 적용된 변경의 자동 롤백은 하지 않는다.
- 브라우저에서는 문서 인스턴스를 유지하고 각 도장 전에 `endBatch()` → `pageCount()`/전체 `renderPageSvg()`로 레이아웃을 강제한 뒤 배치 밖에서 좌표를 측정한다. 워커의 export/reload는 수행하지 않는다. **메모리 편집 상태의 표 칸 쪽 넘김 미갱신 때문에 이 방식으로도 최종 쪽 나눔이 어긋날 수 있다.**
- **현재 브라우저용 `pkg/rhwp.js`에는 `insertPictureInParagraph`가 없고 Node용 `pkg-node/rhwp.js`에는 있다.** 기존 브라우저 번들로는 도장 op가 `stamp_api_unavailable`을 반환한다. 브리지 구현과 mock 검증은 완료했지만 실제 도장 통합 검증에는 신규 API가 포함된 브라우저 WASM 번들이 필요하다. 이 작업에서 WASM을 재생성하지 않았다.

변경 파일:

- `rhwp-studio/src/rhwp-api-bridge.ts`: 배치 어댑터 연결, 지연 초기화, 요청 직렬화.
- `rhwp-studio/src/rhwp-operation-batch.ts`: 기존 op 이전 및 신규 매치/도장/read-back 구현.
- `rhwp-studio/tests/rhwp-operation-batch.test.ts`: 순수 함수·mock 문서 테스트 18개.
- `rhwp-studio/tests/rhwp-api-bridge.test.ts`: 실제 디스패처의 순환 import/출처 필터/요청 순서 mock 테스트 1개.
- `rhwp-studio/package.json`: 기존 Node 내장 테스트 방식을 실행하는 `test` 스크립트 추가.
- `docs/tasks/bridge_paragraph_and_stamp_ops.md`: 이 구현 메모.

검증 결과:

- `npm test --prefix rhwp-studio`: **23 PASS / 0 FAIL / 0 SKIP** (신규 19개 + 기존 4개, Node v24.18.0).
- `npx tsc --noEmit -p rhwp-studio`: **PASS**.
- `cd rhwp-studio && npx vite build`: **PASS**, PWA 산출물 생성 완료. Vite 설정의 `__dirname` 미래 호환성 및 500 kB 초과 JS 청크 경고는 남아 있다.
- `git diff --check`: **PASS**.
- 실제 HTATIS FE 브라우저/WASM 도장 통합 검증: **NOT_RUN**, 작업 문서대로 Claude가 수행할 범위다. 위 결과는 mock/로컬 타입검사/빌드 증거이며 실제 쪽 나눔이나 화면상 도장 위치의 통과를 의미하지 않는다.

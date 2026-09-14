# rhwp — Astra 리뷰 지적 수정 (insertPictureInParagraph · HWPX writer · 브리지)

2026-09-14 리뷰(P1 2·P2 3) 반영. 커밋 금지. 검증: `RUSTUP_TOOLCHAIN=1.93.1 cargo test --no-fail-fast`(전부 통과, 현재 1,126), `cargo clippy`, `cargo check --lib --target wasm32-unknown-unknown`, rhwp-studio `npm test`/타입검사/vite build. 각 항목 회귀 테스트 추가. 완료 후 이 문서 끝에 `## codex 구현 메모`.

1. [P1] HWPX BorderFill id 가 `+1` 두 번 적용됨(`src/serializer/hwpx/header.rs:180` 에서 `idx+1` 을 넘기고 `:196` 이 다시 `id+1` 출력 → 정의 2..N+1, 참조 1..N). 증가를 한 곳에서만 한다. 테스트: `inner-table-01.hwp` → HWPX 출력의 borderFill 정의 id 집합이 참조 id 집합을 모두 포함하고 1부터 시작함을 XML 파싱으로 검증(자체 파서는 id 를 무시하므로 XML 을 직접 검사).
2. [P1] 기존 컨트롤보다 앞 위치에 그림을 넣으면 컨트롤 배열 순서와 갭 순서가 어긋나 앵커가 뒤바뀜(`object_ops.rs:1268` — controls 끝에 push 하면서 갭은 요청 위치). 컨트롤을 **갭 순서에 맞는 인덱스에 삽입**하고(`ctrl_data_records` 도 같은 위치), 반환 `controlIdx` 는 실제 삽입 인덱스. 뒤로 밀린 기존 컨트롤 인덱스 변화는 반환 JSON 에 `shiftedFrom` 없이도 되지만 문서 메모에 명시. 삭제(`deletePictureControl`) 도 같은 대응을 유지. 테스트: `task-001.hwp` 문단 9 에 A(위치 6) → B(위치 1) 삽입 후 `getControlTextPositions` 가 B=1, A=6; HWP/HWPX 재로드 후 동일; B 삭제 후 A=6. 표가 있는 문단에 표 앞/뒤 삽입도 검사(`tests/insert_picture_in_paragraph.rs:143` 의 제외를 없앤다).
3. [P2] 음수 오프셋이 `json_u32` 로 0 이 됨(`object_ops.rs:260` 공용 파서). `vertOffset/horzOffset` 은 signed(i32) 로 읽어 모델에 맞게 저장(모델 필드가 unsigned 면 그 사실을 확인해 명시적으로 `E_INVALID` 로 거부하고 브리지·워커 쪽은 0 으로 clamp 하지 않고 오류를 돌려주게 한다 — 어느 쪽이든 성공 응답과 실제 값이 달라지지 않게). 테스트 추가.
4. [P2] HWPX 그림 writer 가 `description`·`rotationAngle`·`horzFlip`·`originalWidth/Height` 를 고정값으로 씀(`serializer/hwpx/picture.rs:102`, `section.rs:291`). 실제 값을 쓰고 파서가 읽는지 확인(파서가 못 읽으면 파서도 보강). 테스트: HWPX 저장→재로드 후 description/rotation/flip/original size 보존.
5. [P2] `natural_width_px * 75` 등 곱셈 overflow(`object_ops.rs:1378`; 브리지 `rhwp-operation-batch.ts:256` 상한 2^31-1). checked 연산 + 상한(예: 16384px, 결과 i32 범위) 초과 시 오류. 브리지·워커 스펙과 일치하도록 브리지 상한도 같은 값으로.
6. 리뷰 공백: 서로 다른 char_shape 두 개 + 줄 시작 경계 + 복수 컨트롤 조합에서 삭제 후 `line_segs`/`char_shapes` 복원과 HWP/HWPX 재저장 정합 테스트 추가.

## codex 구현 메모

- 기존 미커밋 변경을 보존하며 이 문서의 6개 항목을 구현했다. 커밋하지 않았다.
- BorderFill 정의의 ID 증가는 호출부에서 한 번만 수행한다. `inner-table-01.hwp`를 HWPX로 저장한 ZIP 내 XML을 quick-xml로 직접 파싱하여 정의 ID의 시작값 1, 중복 없음, 실제 참조 집합 포함을 검사한다. 기존 모델에서 `borderFillIDRef=0`은 리소스 ID가 아니라 “테두리/채움 없음” 센티널이므로 정의 포함 검사에서는 제외한다.
- 그림과 `ctrl_data_records`를 문자 갭 순서의 동일 인덱스에 삽입한다. 반환 `controlIdx`는 실제 삽입 인덱스다. **해당 인덱스 이상에 있던 기존 컨트롤의 인덱스는 +1 이동**한다. 같은 문자 위치의 기존 컨트롤 뒤에 삽입한다. 삭제하면 뒤쪽 인덱스는 -1 이동하므로 호출자는 이전 인덱스를 그대로 재사용하면 안 된다. HWPX에서 문자 갭 없이 보관하는 SectionDef/ColumnDef는 앵커·삭제 갭 계산에서 구분한다. 빈 문단의 모든 앵커는 0이며 탭 폭은 UTF-16 8칸으로 계산한다.
- `CommonObjAttr.vertical_offset/horizontal_offset`의 타입은 `HwpUnit=u32`이다. 음수·비정수·i32 범위 초과 오프셋은 `E_INVALID`로 거부하며 삽입과 속성 변경 모두 사전 검증하여 실패 시 문서/BinData를 변경하지 않는다. 브리지는 계산된 절대 좌표가 음수이면 오류를 반환하고 0으로 clamp하지 않는다. 상대 이동량 dx/dy의 음수 자체는 허용하되 최종 절대 좌표가 유효해야 한다.
- HWPX writer가 description(`shapeComment`), 회전각·회전 중심, 가로/세로 flip, 원본 크기를 실제 모델에서 저장한다. 그림 파서에 description(XML escape 포함), rotationInfo, flip 읽기를 추가했다. 원본 크기는 기존 orgSz 파서로 복원한다.
- 참조 워커 `/Users/aiblue/.paseo/worktrees/1428ddiu/impolite-yak/rhwp_node/worker.cjs`의 `stampImageDimensions` 실측 상한은 **4096px**이어서 Rust와 브리지의 자연 크기도 `1..=4096px`로 맞췄다(본문의 16384는 예시). 픽셀→HWPUNIT은 checked 곱셈과 i32 변환을 사용한다. 표시 크기는 `1..=i32::MAX`이고 baseline 곱셈은 i64로 계산한다. 기존 `insertPicture` 경로도 같은 검증을 사용한다. 워커는 읽기 전용으로 확인했으며 clamp 없이 네이티브 API 오류를 전달하는 기존 경로를 유지한다. 이 작업은 설치된 워커/WASM을 갱신하거나 실행한 검증이 아니다.
- 떠 있는 그림 삭제 시 기존 줄 분할을 다시 계산하지 않고 UTF-16 위치만 복원한다. 두 글자모양을 보존하도록 HWPX run을 글자모양 경계에서 분리한다. 줄 시작 경계·서로 다른 두 char_shape·한글/서로게이트/탭·복수 그림 조합의 삭제 복원과 HWP/HWPX 재저장을 검사한다. 해당 픽스처는 샘플의 무관한 표를 제거하여 기존 HWPX 전체 구역 Y좌표 재계산과 분리했고, 별도 표 앞/뒤 삽입 테스트로 표와 그림의 앵커를 검증한다.

### 이번 작업에서 수정한 파일

- `src/document_core/commands/object_ops.rs`
- `src/model/paragraph.rs`
- `src/model/paragraph/tests.rs`
- `src/parser/hwpx/section.rs`
- `src/serializer/hwpx/header.rs`
- `src/serializer/hwpx/picture.rs`
- `src/serializer/hwpx/section.rs`
- `tests/insert_picture_in_paragraph.rs`
- `rhwp-studio/src/rhwp-operation-batch.ts`
- `rhwp-studio/tests/rhwp-operation-batch.test.ts`
- `docs/tasks/insert_picture_review_fixes.md`

다른 기존 변경 파일(package.json, rhwp-api-bridge.ts, context.rs, mod.rs, table.rs, wasm_api.rs 등)은 이번 수정 파일 목록에 포함하지 않았다.

### 검증 결과

최종 변경 상태에서 검증 완료(2026-09-14). Cargo 명령은 모두 `RUSTUP_TOOLCHAIN=1.93.1`로 실행했다.

| 명령 | 결과 |
| --- | --- |
| `RUSTUP_TOOLCHAIN=1.93.1 cargo test --no-fail-fast` | PASS: 1,136 passed / 0 failed / 기존 1 ignored, 종료 코드 0 |
| `RUSTUP_TOOLCHAIN=1.93.1 cargo clippy` | PASS, 경고 없음, 종료 코드 0 |
| `RUSTUP_TOOLCHAIN=1.93.1 cargo check --lib --target wasm32-unknown-unknown` | PASS, 경고 없음, 종료 코드 0 |
| rhwp-studio `npm test` | PASS: 26 passed / 0 failed / 0 skipped |
| rhwp-studio `npx tsc --noEmit` | PASS |
| rhwp-studio `npx vite build` | PASS, PWA 생성 완료 |
| `git diff --check` | PASS |

- 그림 통합 테스트 파일은 기존 9개에서 18개로 확대했다. 문자 갭 없는 HWPX metadata와 본문 컨트롤 위치 조합의 모델 단위 테스트도 추가했다.
- ignored 1개는 기존 `document_core::commands::header_footer_ops::tests::test_p222_header_structure`이며 실행 성공으로 계산하지 않았다.
- 전체 Rust 테스트 빌드의 기존 경고 4개(테스트 함수 snake_case 2개, 미사용 Result 2개)는 남아 있다. Vite에는 기존 configLoader/`__dirname` 안내와 500 kB 초과 청크 안내가 있다. 실패는 없다.
- 원시 로그: `/tmp/rhwp-review-cargo-test-final.log`, `/tmp/rhwp-review-clippy-final.log`, `/tmp/rhwp-review-wasm-final.log`, `/tmp/rhwp-review-npm-test.log`, `/tmp/rhwp-review-tsc.log`, `/tmp/rhwp-review-build.log`.
- 검증 범위는 네이티브 HWP/HWPX 저장·재로드 및 SVG 렌더링, WASM 컴파일 검사, 브리지 단위 테스트와 스튜디오 빌드다. 브라우저 실동작·외부 워커 배포·설치된 WASM 교체는 수행하지 않았다.

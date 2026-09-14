# rhwp — 기존 문단에 그림 컨트롤을 얹는 API `insertPictureInParagraph`

배경: HTATIS 백엔드(`/Users/aiblue/.paseo/worktrees/1428ddiu/impolite-yak`, 읽기 전용)의 도장 삽입 규칙이 `(인)` 글자 위에 직인 이미지를 겹쳐 놓아야 한다. 현재 `insert_picture_native`(`src/document_core/commands/object_ops.rs` ~1039-1257)는 **그림 문단 + 빈 문단을 새로 삽입**해 호스트 문단 번호가 밀린다(문단 수 144→146). 필요한 것은 기존 문단을 그대로 두고 그 문단의 `controls` 에 떠 있는(treat_as_char=false) 그림 컨트롤을 추가하는 API 다. 커밋 금지. 완료 후 이 문서 끝에 `## codex 구현 메모`(변경 파일·판단·테스트 결과).

## 요구
1. 네이티브 `insert_picture_in_paragraph_native(section_idx, para_idx, char_offset, image_data, width, height, natural_width_px, natural_height_px, extension, description, props_json) -> Result<String, HwpError>` 와 wasm 바인딩 `#[wasm_bindgen(js_name = insertPictureInParagraph)]`(`src/wasm_api.rs` 의 `insertPicture` 옆). 반환 JSON `{"ok":true,"paraIdx":<호스트 문단>,"controlIdx":<추가된 컨트롤 인덱스>}`.
2. 동작: `insert_picture_native` 와 같은 방식으로 `BinData`·`Picture`(ShapeComponentAttr, CropInfo, ImageAttr)를 만들되, 새 문단을 만들지 않고 **표를 문단에 인라인 삽입하는 코드(`insert_table` 경로, 같은 파일 ~986-1035: `para.controls.push`, `para.ctrl_data_records.push(None)`, 확장 제어문자 8 UTF-16 코드유닛 갭을 `char_offsets`/`text`/`char_shapes`/`line_segs` 에 반영, `control_mask`·`has_para_text` 갱신)** 를 그대로 따라 호스트 문단에 컨트롤을 붙인다. 표 삽입 경로에서 문단 텍스트에 넣는 제어문자와 같은 규약(확장 제어문자 + `ctrl_data_records`)을 쓴다. 문단의 기존 컨트롤(표 등)이 있어도 뒤에 추가되며 기존 컨트롤 인덱스는 바뀌지 않는다.
3. `props_json` 은 `set_picture_properties_native` 가 받는 키(`treatAsChar`, `textWrap`, `vertRelTo`, `horzRelTo`, `vertAlign`, `horzAlign`, `vertOffset`, `horzOffset`, `width`, `height` …)와 같은 형식이며 삽입 직후 같은 파서로 적용한다(파서 함수를 재사용하거나 공용 함수로 뽑을 것). 기본값(props 미지정)은 `treatAsChar=false`, `textWrap=InFrontOfText`, `vertRelTo=Paper`, `horzRelTo=Paper`, `vertAlign=Top`, `horzAlign=Left`, 오프셋 0 — 즉 용지 기준 절대 위치의 떠 있는 개체. `CommonObjAttr.attr` 비트 필드도 treat_as_char=false 와 text_wrap 에 맞게 갱신해야 한다(`set_picture_properties_native` 가 하는 방식과 동일하게).
4. 삽입 후 `recompose_section`·`paginate_if_needed`·이벤트 로그(`DocumentEvent::PictureInserted` 재사용 가능)는 기존과 같이.
5. 직렬화: `.hwp` 저장(`src/serializer`)과 `.hwpx` 저장 경로가 텍스트 문단 안의 `Control::Picture` 를 올바르게 기록해야 한다. 표(`Control::Table`)가 텍스트 문단 안에서 저장되는 경로와 같은 곳을 확인하고, 그림이 빠지거나 문단이 깨지면 고친다. 렌더(`src/renderer`)도 텍스트 문단에 붙은 떠 있는 그림을 그려야 한다(표 문단의 떠 있는 개체 렌더 경로 확인). `getPictureProperties`/`setPictureProperties`/`deletePictureControl` 이 새 컨트롤에도 동작해야 한다.
6. 기존 `insertPicture` 동작은 바꾸지 않는다.

## 테스트 (네이티브 `cargo test`, 새 파일 `tests/insert_picture_in_paragraph.rs`)
- 샘플 HWP(`samples/` 또는 `tests/` 가 쓰는 픽스처)에서 (a) 텍스트 문단, (b) 표를 담고 있는 문단, (c) `char_offset` 이 문단 중간인 경우에 16×16 PNG(테스트 안에서 바이트 생성)를 넣고: 문단 수 불변, 호스트 문단 텍스트(제어문자 제외) 불변, `controls.len()` 증가·반환 controlIdx 일치, `getPictureProperties` 가 `treatAsChar=false`·`textWrap=InFrontOfText`·지정한 오프셋을 돌려줌.
- HWP 로 저장 → 다시 파싱 → 같은 검사 통과(그림 컨트롤·속성 유지). HWPX 저장 경로가 있으면 같은 검사.
- 페이지 SVG 렌더(`renderPageSvg` 계열 네이티브 함수)가 패닉 없이 그림 요소를 포함.
- 기존 `cargo test` 전부 통과, `cargo clippy` 는 레포 정책(`Cargo.toml` 의 lint 절)대로.

## 검증 명령
`cargo test`(네이티브), 필요하면 `cargo test --test insert_picture_in_paragraph`. wasm 빌드(`docker compose --env-file .env.docker run --rm wasm-node`)는 Claude 가 돌린다 — 다만 `cargo check --target wasm32-unknown-unknown` 이 되면 돌려서 wasm 바인딩이 컴파일되는지 확인할 것.

## codex 구현 메모

2026-09-14 구현. 커밋하지 않음.

### 변경 파일

- `src/document_core/commands/object_ops.rs`
  - `insert_picture_in_paragraph_native` 추가. 기존 호스트 문단에 그림을 append하고 `paraIdx`·`controlIdx` 반환.
  - 기존 `insert_picture_native`의 BinData/Picture 생성 부분을 공용 생성 함수로 추출. 기존 API의 문단 삽입 동작은 유지.
  - 삽입과 `set_picture_properties_native`가 `apply_picture_properties` 파서를 공유. 그림의 위치·정렬·배치와 HWP 저장용 `CommonObjAttr.attr` 비트를 동기화.
  - 그림 삭제 시 글자모양·줄 시작·범위 태그의 UTF-16 위치도 복원하고 그림/표 계열 마스크 갱신.
- `src/wasm_api.rs`: `insertPicture` 옆에 `insertPictureInParagraph` 바인딩 추가. 마지막 `props_json` 인자를 생략할 수 있음.
- `src/serializer/hwpx/section.rs`: 문단 내 컨트롤 갭을 따라 기존 그림·표 writer를 호출. 텍스트 중간 그림도 저장.
- `src/serializer/hwpx/table.rs`: 표 셀의 중첩 컨트롤도 동일한 문단 run 직렬화 경로 사용.
- `src/serializer/hwpx/mod.rs`: 표 writer의 참조 검증에 필요한 가변 직렬화 컨텍스트 전달.
- `src/serializer/hwpx/context.rs`, `src/serializer/hwpx/header.rs`: 실제 표 저장에서 발견한 BorderFill ID 불일치 수정. IR과 동일한 1-based ID 사용, 0은 미지정 참조로 처리.
- `tests/insert_picture_in_paragraph.rs`: 16×16 PNG를 테스트 안에서 생성하는 네이티브 통합 테스트 9개 추가.
- `docs/tasks/insert_picture_in_paragraph.md`: 이 구현 메모 추가.

### 구현 판단과 확인 범위

- 이 저장소의 확장 제어문자는 `Paragraph.text`에 리터럴 제어문자를 넣지 않고 `char_offsets`의 8 UTF-16 단위 갭과 `controls`/`ctrl_data_records`로 표현한다. 기존 표 삽입 규약을 따르며 텍스트 문자열과 기존 컨트롤 인덱스는 유지한다. `char_shapes`, `line_segs`, `range_tags`, `char_count`, `control_mask`, `has_para_text`를 함께 갱신한다.
- 네이티브 API의 `props_json: &str`에 빈 문자열 또는 `{}`를 주면 용지 기준·글 앞으로·떠 있는 그림이 된다. 위치/정렬/오프셋 기본값은 요청 문서대로이며, 재조판·필요 시 페이지네이션·`PictureInserted` 이벤트를 수행한다.
- HWP 바이너리 직렬화와 본문 렌더러는 이미 문단 안의 그림 컨트롤을 처리하므로 해당 파일은 수정하지 않았다. 실제 HWP 저장/재로드와 삽입 PNG를 포함하는 페이지 SVG로 확인했다.
- 샘플은 `samples/task-001.hwp`, `samples/inner-table-01.hwp`. 텍스트 문단·표 문단·문단 중간·빈 문단에 대해 문단 수와 텍스트 보존, 기존 컨트롤 유지, 그림 데이터·크기·크롭·배치·오프셋, HWP/HWPX 재로드, SVG의 삽입 PNG를 확인했다. HWPX의 구역/단 메타데이터 표현 차이는 그림·표 컨트롤과 구분해서 검사한다.
- 추가로 속성 변경 후 HWP 재로드, 삽입 시 공용 속성 파서 적용, 이모지/탭과 서식·범위 태그 위치 복원, 잘못된 인자에서 무변경, 기존 `insertPicture`의 문단 추가 동작을 검사했다.
- Docker wasm-node 빌드와 생성된 JS/WASM 배포 파일 갱신은 수행하지 않았다(문서에서 Claude 담당으로 지정).

### 최종 테스트 결과

이 환경은 rustup 기본 툴체인이 미설정이므로 아래 Cargo 명령은 모두 `RUSTUP_TOOLCHAIN=1.93.1`을 지정해 실행했다.

| 검증 | 결과 |
| --- | --- |
| `cargo test --test insert_picture_in_paragraph` | **9 passed / 0 failed** |
| `cargo test --no-fail-fast` | **1,126 passed / 0 failed / 1 ignored**. 기존 SVG 스냅샷 6개 포함 |
| `cargo clippy` | **PASS**, 경고 없음. `Cargo.toml` lint 정책 적용 |
| `cargo check --lib --target wasm32-unknown-unknown` | **PASS**, 새 wasm 바인딩 컴파일 확인 |
| `cargo check --target wasm32-unknown-unknown` | **FAIL**, CLI까지 포함하면 `src/main.rs:253`에서 네이티브 전용 `render_page_svg_with_fonts`를 호출해 E0599 및 연쇄 오류 발생. 해당 메서드는 `src/document_core/queries/rendering.rs:89`의 `cfg(not(target_arch = "wasm32"))` 대상이며, 두 파일 모두 이번 변경 대상이 아님 |
| `git diff --check` | **PASS** |

기존 ignored 항목은 `document_core::commands::header_footer_ops::tests::test_p222_header_structure`이며 실행 성공으로 계산하지 않았다. 전체 테스트 빌드의 기존 경고 4개(테스트 함수 명명/사용하지 않은 Result)는 그대로다.

실행 로그: `/tmp/rhwp-insert-test.log`, `/tmp/rhwp-insert-full-test.log`, `/tmp/rhwp-insert-clippy.log`, `/tmp/rhwp-insert-wasm-lib-check.log`, `/tmp/rhwp-insert-wasm-check.log`.

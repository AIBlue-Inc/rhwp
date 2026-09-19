//! [htatis] 구역 삭제(`delete_section_native`)와 표 「쪽 경계에서 나눔」 저장 회귀 테스트.
//!
//! HTATIS 는 공고문 원본에서 서식 쪽만 잘라 채운다. 문단 삭제로는 구역의 마지막 문단을 지울 수
//! 없어, 쪽 범위 밖 구역이 빈 문단 하나(빈 쪽 1장)로 남았다(강진·단양 공고문). 구역을 통째로
//! 지우면 그 쪽이 사라지고, 저장본을 다시 열어도 구역 수·본문이 그대로여야 한다.
//!
//! 표는 원본 attr 을 그대로 쓰던 탓에 모델에서 바꾼 쪽 나눔·제목 줄 반복이 저장본에서 사라졌다.
#![cfg(not(target_arch = "wasm32"))]

use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::table::{Table, TablePageBreak};

/// 구역 셋("첫째"·"둘째"·"셋째")짜리 문서를 저장했다가 다시 연 것 — 실제 파일처럼 DocInfo
/// 원본 바이트를 지닌 상태.
fn three_section_document() -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native()
        .expect("blank2010 템플릿 로드");
    let mut doc = core.document().clone();
    let first = doc.sections[0].clone();
    doc.sections.push(first.clone());
    doc.sections.push(first);
    doc.doc_properties.section_count = 3;
    if let Some(raw) = doc.doc_info.raw_stream.as_mut() {
        rhwp::serializer::doc_info::surgical_update_section_count(raw, 3).expect("구역 수 갱신");
    }
    core.set_document(doc);
    for (sec, text) in ["첫째", "둘째", "셋째"].iter().enumerate() {
        core.insert_text_native(sec, 0, 0, text)
            .expect("구역 첫 문단에 텍스트");
    }
    let bytes = core.export_hwp_native().expect("저장");
    DocumentCore::from_bytes(&bytes).expect("다시 열기")
}

fn section_texts(core: &DocumentCore) -> Vec<String> {
    core.document()
        .sections
        .iter()
        .map(|s| {
            s.paragraphs
                .iter()
                .map(|p| p.text.as_str())
                .collect::<String>()
        })
        .collect()
}

#[test]
fn fixture_has_three_sections_on_three_pages() {
    let core = three_section_document();
    assert_eq!(section_texts(&core), ["첫째", "둘째", "셋째"]);
    assert_eq!(core.page_count(), 3, "구역마다 새 쪽에서 시작한다");
    assert!(
        core.document().doc_info.raw_stream.is_some(),
        "DocInfo 원본 바이트를 지녀야 한다"
    );
}

#[test]
fn delete_section_removes_its_page_and_survives_save() {
    let mut core = three_section_document();
    let result = core.delete_section_native(0).expect("앞 구역 삭제");
    assert!(result.contains("\"sectionCount\":2"), "{result}");
    assert!(result.contains("\"pageCount\":2"), "{result}");
    assert_eq!(section_texts(&core), ["둘째", "셋째"]);

    core.delete_section_native(1).expect("뒤 구역 삭제");
    assert_eq!(section_texts(&core), ["둘째"]);
    assert_eq!(core.page_count(), 1);

    let reopened =
        DocumentCore::from_bytes(&core.export_hwp_native().expect("저장")).expect("다시 열기");
    assert_eq!(section_texts(&reopened), ["둘째"]);
    assert_eq!(
        reopened.document().doc_properties.section_count,
        1,
        "DocInfo 의 구역 수도 줄어야 한다"
    );
    assert_eq!(reopened.page_count(), 1);
}

#[test]
fn delete_section_keeps_editing_the_sections_after_it() {
    let mut core = three_section_document();
    core.delete_section_native(1).expect("가운데 구역 삭제");
    // 지운 구역 자리의 캐시가 밀려 있으면 여기서 엉뚱한 구역을 고치거나 패닉이 난다.
    core.insert_text_native(1, 0, 0, "새 ")
        .expect("뒤 구역 편집");
    assert_eq!(section_texts(&core), ["첫째", "새 셋째"]);
    assert_eq!(core.page_count(), 2);
}

#[test]
fn delete_section_rejects_the_last_section_and_bad_indices() {
    let mut core = three_section_document();
    assert!(core.delete_section_native(3).is_err());
    core.delete_section_native(2).expect("삭제");
    core.delete_section_native(1).expect("삭제");
    assert!(
        core.delete_section_native(0).is_err(),
        "마지막 구역은 지울 수 없다"
    );
    assert_eq!(section_texts(&core), ["첫째"]);
}

/// 첫 표를 고칠 수 있게 꺼낸다. 편집 명령처럼 그 구역의 원본 바이트를 버려, 저장이 모델에서
/// 다시 직렬화하게 한다(원본 바이트가 남아 있으면 고친 모델이 저장본에 닿지 않는다).
fn first_table(core: &mut DocumentCore) -> &mut Table {
    let section = core
        .document_mut()
        .sections
        .iter_mut()
        .find(|s| {
            s.paragraphs
                .iter()
                .any(|p| p.controls.iter().any(|c| matches!(c, Control::Table(_))))
        })
        .expect("표가 있는 구역");
    section.raw_stream = None;
    section
        .paragraphs
        .iter_mut()
        .flat_map(|p| p.controls.iter_mut())
        .find_map(|c| match c {
            Control::Table(t) => Some(t.as_mut()),
            _ => None,
        })
        .expect("표")
}

fn saved(core: &DocumentCore) -> DocumentCore {
    DocumentCore::from_bytes(&core.export_hwp_native().expect("저장")).expect("다시 열기")
}

/// 모델이 읽지 않는 attr 비트 — 저장해도 그대로 남아야 한다.
const OTHER_BIT: u32 = 0x10;

/// 저장했다가 다시 연 2x2 표(나누지 않음·제목 줄 반복) — 원본 attr 을 지닌 상태.
///
/// 새로 만든 표는 원본 attr 이 0 이라 모델에서 다시 짓는 경로를 탄다. 파일에서 읽은 표처럼
/// 원본 attr 경로를 타도록 한 번 저장했다가 다시 열고, 모델이 모르는 비트도 하나 얹는다.
fn table_document() -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native()
        .expect("blank2010 템플릿 로드");
    core.create_table_native(0, 0, 0, 2, 2).expect("표 삽입");
    let table = first_table(&mut core);
    table.page_break = TablePageBreak::None;
    table.repeat_header = true;
    let mut reopened = saved(&core);
    let table = first_table(&mut reopened);
    assert_eq!(
        table.raw_table_record_attr & 0x07,
        0x04,
        "나누지 않음 + 제목 줄 반복"
    );
    table.raw_table_record_attr |= OTHER_BIT;
    reopened
}

#[test]
fn changed_table_page_break_survives_save() {
    for (page_break, bits) in [
        (TablePageBreak::RowBreak, 2),
        (TablePageBreak::None, 0),
        (TablePageBreak::CellBreak, 1),
    ] {
        let mut core = table_document();
        let table = first_table(&mut core);
        let start = table.page_break;
        if start == page_break {
            table.page_break = TablePageBreak::RowBreak;
            let mut again = saved(&core);
            assert_eq!(first_table(&mut again).page_break, TablePageBreak::RowBreak);
            first_table(&mut again).page_break = page_break;
            core = again;
        } else {
            table.page_break = page_break;
        }
        let mut reopened = saved(&core);
        let table = first_table(&mut reopened);
        assert_eq!(table.page_break, page_break);
        assert_eq!(table.raw_table_record_attr & 0x03, bits);
        assert_eq!(
            table.raw_table_record_attr & !0x03,
            OTHER_BIT | 0x04,
            "다른 비트는 그대로"
        );
    }
}

#[test]
fn unchanged_raw_page_break_value_is_kept() {
    // 원본 3 은 1 과 같이 셀 단위로 읽힌다 — 모델이 그대로면 원본 값을 바꾸지 않는다.
    let mut core = table_document();
    let table = first_table(&mut core);
    table.raw_table_record_attr = (table.raw_table_record_attr & !0x03) | 0x03;
    table.page_break = TablePageBreak::CellBreak;
    let mut reopened = saved(&core);
    assert_eq!(
        first_table(&mut reopened).raw_table_record_attr & 0x03,
        0x03
    );
    assert_eq!(
        first_table(&mut reopened).page_break,
        TablePageBreak::CellBreak
    );
}

#[test]
fn changed_repeat_header_survives_save() {
    let mut core = table_document();
    let start = first_table(&mut core).repeat_header;
    first_table(&mut core).repeat_header = !start;
    let mut reopened = saved(&core);
    assert_eq!(first_table(&mut reopened).repeat_header, !start);
    assert_eq!(
        first_table(&mut reopened).raw_table_record_attr & OTHER_BIT,
        OTHER_BIT
    );
    first_table(&mut reopened).repeat_header = start;
    let mut back = saved(&reopened);
    assert_eq!(first_table(&mut back).repeat_header, start);
}

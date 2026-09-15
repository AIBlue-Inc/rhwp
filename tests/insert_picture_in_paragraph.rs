//! [HTATIS] `insert_picture_in_paragraph_native` — 기존 문단에 떠 있는 그림을 얹는 API.
//!
//! HTATIS 직인 삽입은 `(인)` 글자 위에 이미지를 겹쳐야 해서 호스트 문단과 구역 문단 수를
//! 그대로 둔 채 그림 컨트롤만 추가한다. 삽입·속성 변경·삭제·HWP/HWPX 왕복에서 앵커와
//! 글자 좌표(char_offsets/char_shapes/line_segs/range_tags)가 보존되는지 검사한다.

use std::io::Cursor;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use rhwp::document_core::DocumentCore;
use rhwp::model::control::Control;
use rhwp::model::paragraph::{CharShapeRef, LineSeg, RangeTag};
use rhwp::model::shape::{HorzRelTo, TextWrap, VertRelTo};

fn png() -> Vec<u8> {
    let image = RgbaImage::from_pixel(16, 16, Rgba([220, 0, 0, 255]));
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

fn sample(table: bool) -> (DocumentCore, usize, usize) {
    let filename = if table {
        "inner-table-01.hwp"
    } else {
        "task-001.hwp"
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("samples")
        .join(filename);
    let core = DocumentCore::from_bytes(&std::fs::read(path).unwrap()).unwrap();
    for (si, section) in core.document().sections.iter().enumerate() {
        for (pi, para) in section.paragraphs.iter().enumerate() {
            if if table {
                para.controls.iter().any(|c| matches!(c, Control::Table(_)))
            } else {
                para.controls.is_empty() && para.text.chars().count() > 3
            } {
                return (core, si, pi);
            }
        }
    }
    panic!("sample must contain a suitable host paragraph");
}

fn insert(core: &mut DocumentCore, si: usize, pi: usize, offset: usize, props: &str) -> usize {
    let ci = core.document().sections[si].paragraphs[pi]
        .control_text_positions()
        .partition_point(|&pos| pos <= offset);
    let result = core
        .insert_picture_in_paragraph_native(
            si,
            pi,
            offset,
            &png(),
            1200,
            1200,
            16,
            16,
            "png",
            "직인",
            props,
        )
        .unwrap();
    assert_eq!(
        result,
        format!("{{\"ok\":true,\"paraIdx\":{pi},\"controlIdx\":{ci}}}")
    );
    ci
}

fn check_picture(core: &DocumentCore, si: usize, pi: usize, ci: usize, x: u32, y: u32) {
    let Control::Picture(pic) = &core.document().sections[si].paragraphs[pi].controls[ci] else {
        panic!("inserted control must be a picture");
    };
    assert!(!pic.common.treat_as_char);
    assert_eq!(pic.common.text_wrap, TextWrap::InFrontOfText);
    assert_eq!(pic.common.vert_rel_to, VertRelTo::Paper);
    assert_eq!(pic.common.horz_rel_to, HorzRelTo::Paper);
    assert_eq!((pic.common.width, pic.common.height), (1200, 1200));
    assert_eq!(
        (pic.common.horizontal_offset, pic.common.vertical_offset),
        (x, y)
    );
    let props = core.get_picture_properties_native(si, pi, ci).unwrap();
    for entry in [
        "\"treatAsChar\":false".to_string(),
        "\"textWrap\":\"InFrontOfText\"".to_string(),
        format!("\"horzOffset\":{x}"),
        format!("\"vertOffset\":{y}"),
    ] {
        assert!(props.contains(&entry), "{props} must contain {entry}");
    }
    let data = core
        .document()
        .bin_data_content
        .iter()
        .find(|b| {
            core.document()
                .doc_info
                .bin_data_list
                .get(pic.image_attr.bin_data_id as usize - 1)
                .is_some_and(|meta| meta.storage_id == b.id)
        })
        .unwrap();
    assert_eq!(data.data.load(), png());
    assert_eq!((pic.crop.right, pic.crop.bottom), (1200, 1200));
}

fn assert_renders_picture(core: &DocumentCore) {
    assert!(
        (0..core.page_count()).any(|page| {
            let svg = core.render_page_svg_native(page).unwrap();
            svg.contains("<image")
                && svg.contains(&base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    png(),
                ))
        }),
        "page SVG must contain the inserted PNG"
    );
}

fn roundtrip_case(table: bool, middle: bool) {
    let (mut core, si, pi) = sample(table);
    let before = core.document().sections[si].paragraphs[pi].clone();
    let count = core.document().sections[si].paragraphs.len();
    let offset = if middle {
        before.text.chars().count() / 2
    } else {
        0
    };
    let ci = insert(
        &mut core,
        si,
        pi,
        offset,
        r#"{"horzOffset":7200,"vertOffset":10800}"#,
    );
    // 글자 없는 문단(표 문단)은 갭 대신 인라인 컨트롤 차례로 앵커를 센다(#4347: 표@0 그림@8) —
    // 구역/단 정의 같은 비인라인 컨트롤은 세지 않으므로, 표 뒤 그림의 앵커는 1 이다.
    let anchor = if before.text.is_empty() {
        before
            .controls
            .iter()
            .filter(|c| {
                matches!(
                    c,
                    Control::Shape(_)
                        | Control::Table(_)
                        | Control::Picture(_)
                        | Control::Equation(_)
                        | Control::Footnote(_)
                        | Control::Endnote(_)
                        | Control::AutoNumber(_)
                )
            })
            .count()
    } else {
        offset
    };
    let after = &core.document().sections[si].paragraphs[pi];
    assert_eq!(core.document().sections[si].paragraphs.len(), count);
    assert_eq!(after.text, before.text);
    assert_eq!(after.controls.len(), before.controls.len() + 1);
    assert_eq!(after.ctrl_data_records.len(), after.controls.len());
    assert_eq!(after.char_count, before.char_count + 8);
    assert_ne!(after.control_mask & (1 << 11), 0);
    assert!(after.has_para_text);
    for (old, new) in before.controls.iter().zip(
        after
            .controls
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != ci)
            .map(|(_, c)| c),
    ) {
        assert_eq!(
            format!("{old:?}"),
            format!("{new:?}"),
            "existing control must be unchanged"
        );
    }
    assert_eq!(after.control_text_positions()[ci], anchor);
    check_picture(&core, si, pi, ci, 7200, 10800);
    assert_renders_picture(&core);

    let hwp = core.export_hwp_native().unwrap();
    let reloaded = DocumentCore::from_bytes(&hwp).unwrap();
    let para = &reloaded.document().sections[si].paragraphs[pi];
    assert_eq!(reloaded.document().sections[si].paragraphs.len(), count);
    assert_eq!(para.text, before.text);
    assert_eq!(para.controls.len(), before.controls.len() + 1);
    assert_eq!(para.char_offsets, after.char_offsets);
    check_picture(&reloaded, si, pi, ci, 7200, 10800);
    assert_renders_picture(&reloaded);

    let hwpx = core.export_hwpx_native().unwrap();
    let reloaded = DocumentCore::from_bytes(&hwpx).unwrap();
    let para = &reloaded.document().sections[si].paragraphs[pi];
    assert_eq!(reloaded.document().sections[si].paragraphs.len(), count);
    assert_eq!(para.text, before.text);
    // HWPX stores section/column metadata separately from object controls.
    let pictures: Vec<_> = para
        .controls
        .iter()
        .enumerate()
        .filter(|(_, c)| matches!(c, Control::Picture(_)))
        .collect();
    assert_eq!(pictures.len(), 1);
    if table {
        assert_eq!(
            para.controls
                .iter()
                .filter(|c| matches!(c, Control::Table(_)))
                .count(),
            before
                .controls
                .iter()
                .filter(|c| matches!(c, Control::Table(_)))
                .count()
        );
    }
    assert_eq!(
        para.control_text_positions()[pictures[0].0],
        anchor,
        "text={:?}, count={}, offsets={:?}, controls={:?}",
        para.text,
        para.char_count,
        para.char_offsets,
        para.controls
            .iter()
            .map(std::mem::discriminant)
            .collect::<Vec<_>>()
    );
    check_picture(&reloaded, si, pi, pictures[0].0, 7200, 10800);
    assert_renders_picture(&reloaded);
}

#[test]
fn text_paragraph_roundtrips_and_renders() {
    roundtrip_case(false, false);
}

#[test]
fn table_paragraph_roundtrips_and_renders() {
    roundtrip_case(true, false);
}

#[test]
fn middle_of_text_roundtrips_and_renders() {
    roundtrip_case(false, true);
}

#[test]
fn defaults_updates_and_deletion_preserve_host() {
    let (mut core, si, pi) = sample(false);
    let before = core.document().sections[si].paragraphs[pi].clone();
    let ci = insert(&mut core, si, pi, before.text.chars().count(), "");
    check_picture(&core, si, pi, ci, 0, 0);
    core.set_picture_properties_native(si, pi, ci,
        r#"{"width":2400,"height":1800,"textWrap":"BehindText","vertRelTo":"Page","horzRelTo":"Para","vertAlign":"Bottom","horzAlign":"Right","horzOffset":345,"vertOffset":678}"#).unwrap();
    let reloaded = DocumentCore::from_bytes(&core.export_hwp_native().unwrap()).unwrap();
    assert_eq!(
        core.get_picture_properties_native(si, pi, ci).unwrap(),
        reloaded.get_picture_properties_native(si, pi, ci).unwrap()
    );
    core.delete_picture_control_native(si, pi, ci).unwrap();
    let after = &core.document().sections[si].paragraphs[pi];
    assert_eq!(after.text, before.text);
    assert_eq!(after.controls.len(), before.controls.len());
    assert_eq!(after.char_offsets, before.char_offsets);
    assert_eq!(after.char_count, before.char_count);
}

#[test]
fn unicode_tabs_styles_and_ranges_survive_insert_delete() {
    let (mut core, _, _) = sample(false);
    let mut doc = core.document().clone();
    let para = &mut doc.sections[0].paragraphs[0];
    para.text = "가😀\t나끝".into();
    para.controls.clear();
    para.ctrl_data_records.clear();
    para.char_offsets = vec![0, 1, 3, 11, 12];
    para.char_count = 14;
    para.char_shapes = vec![
        CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        },
        CharShapeRef {
            start_pos: 11,
            char_shape_id: 0,
        },
    ];
    para.range_tags = vec![RangeTag {
        start: 11,
        end: 13,
        tag: 0,
    }];
    para.line_segs = vec![
        LineSeg {
            text_start: 0,
            ..Default::default()
        },
        LineSeg {
            text_start: 12,
            ..Default::default()
        },
    ];
    core.set_document(doc);
    let ci = insert(&mut core, 0, 0, 3, "{}");
    let para = &core.document().sections[0].paragraphs[0];
    assert_eq!(para.char_offsets, vec![0, 1, 3, 19, 20]);
    assert_eq!(para.char_shapes[1].start_pos, 19);
    assert_eq!((para.range_tags[0].start, para.range_tags[0].end), (19, 21));
    assert_eq!(para.line_segs[1].text_start, 20);
    core.delete_picture_control_native(0, 0, ci).unwrap();
    let para = &core.document().sections[0].paragraphs[0];
    assert_eq!(para.char_offsets, vec![0, 1, 3, 11, 12]);
    assert_eq!(para.char_shapes[1].start_pos, 11);
    assert_eq!((para.range_tags[0].start, para.range_tags[0].end), (11, 13));
}

#[test]
fn invalid_inputs_do_not_mutate_document() {
    let (mut core, si, pi) = sample(false);
    let before = core.export_hwp_native().unwrap();
    let data = png();
    for (s, p, offset, bytes) in [
        (usize::MAX, pi, 0, data.as_slice()),
        (si, usize::MAX, 0, data.as_slice()),
        (si, pi, usize::MAX, data.as_slice()),
        (si, pi, 0, &[][..]),
    ] {
        assert!(core
            .insert_picture_in_paragraph_native(
                s, p, offset, bytes, 1200, 1200, 16, 16, "png", "", ""
            )
            .is_err());
        assert_eq!(core.export_hwp_native().unwrap(), before);
    }
}

#[test]
fn insertion_uses_the_same_property_parser_as_updates() {
    let (mut core, si, pi) = sample(false);
    let count = core.document().sections[si].paragraphs.len();
    let ci = insert(
        &mut core,
        si,
        pi,
        1,
        r#"{"treatAsChar":true,"textWrap":"TopAndBottom","width":2400,"height":1800,"vertRelTo":"Page","horzRelTo":"Para","vertAlign":"Bottom","horzAlign":"Right","horzOffset":345,"vertOffset":678,"brightness":20,"cropLeft":75,"outerMarginLeft":100}"#,
    );
    let props = core.get_picture_properties_native(si, pi, ci).unwrap();
    for entry in [
        "\"treatAsChar\":true",
        "\"textWrap\":\"TopAndBottom\"",
        "\"width\":2400",
        "\"height\":1800",
        "\"brightness\":20",
        "\"cropLeft\":75",
        "\"outerMarginLeft\":100",
    ] {
        assert!(props.contains(entry), "{props} must contain {entry}");
    }
    let reloaded = DocumentCore::from_bytes(&core.export_hwp_native().unwrap()).unwrap();
    assert_eq!(reloaded.document().sections[si].paragraphs.len(), count);
    assert_eq!(
        reloaded.get_picture_properties_native(si, pi, ci).unwrap(),
        props
    );
}

#[test]
fn empty_host_remains_one_paragraph_and_roundtrips() {
    let (mut core, si, pi) = sample(false);
    let mut document = core.document().clone();
    let para = &mut document.sections[si].paragraphs[pi];
    para.text.clear();
    para.char_offsets.clear();
    para.controls.clear();
    para.ctrl_data_records.clear();
    para.char_count = 1;
    para.has_para_text = false;
    core.set_document(document);
    let count = core.document().sections[si].paragraphs.len();
    let ci = insert(&mut core, si, pi, 0, "");
    for bytes in [
        core.export_hwp_native().unwrap(),
        core.export_hwpx_native().unwrap(),
    ] {
        let reloaded = DocumentCore::from_bytes(&bytes).unwrap();
        assert_eq!(reloaded.document().sections[si].paragraphs.len(), count);
        let para = &reloaded.document().sections[si].paragraphs[pi];
        assert!(para.text.is_empty());
        assert_eq!(para.controls.len(), 1);
        check_picture(&reloaded, si, pi, ci, 0, 0);
        assert_renders_picture(&reloaded);
    }
}

fn task_paragraph_nine() -> DocumentCore {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("samples/task-001.hwp");
    let core = DocumentCore::from_bytes(&std::fs::read(path).unwrap()).unwrap();
    assert!(core.document().sections[0].paragraphs[9]
        .controls
        .is_empty());
    core
}

fn picture_anchors(core: &DocumentCore, pi: usize) -> Vec<(String, usize)> {
    let para = &core.document().sections[0].paragraphs[pi];
    let positions = para.control_text_positions();
    para.controls
        .iter()
        .enumerate()
        .filter_map(|(i, c)| match c {
            Control::Picture(pic) => Some((pic.common.description.clone(), positions[i])),
            _ => None,
        })
        .collect()
}

fn named_insert(core: &mut DocumentCore, offset: usize, name: &str) -> usize {
    insert(
        core,
        0,
        9,
        offset,
        &format!(r#"{{"description":"{name}"}}"#),
    )
}

#[test]
fn reverse_order_pictures_keep_anchors_after_both_roundtrips_and_delete() {
    let mut core = task_paragraph_nine();
    assert_eq!(named_insert(&mut core, 6, "A"), 0);
    assert_eq!(named_insert(&mut core, 1, "B"), 0);
    let expected = vec![("B".into(), 1), ("A".into(), 6)];
    assert_eq!(picture_anchors(&core, 9), expected);
    for bytes in [
        core.export_hwp_native().unwrap(),
        core.export_hwpx_native().unwrap(),
    ] {
        let mut reloaded = DocumentCore::from_bytes(&bytes).unwrap();
        assert_eq!(picture_anchors(&reloaded, 9), expected);
        reloaded.delete_picture_control_native(0, 9, 0).unwrap();
        assert_eq!(picture_anchors(&reloaded, 9), vec![("A".into(), 6)]);
        for saved in [
            reloaded.export_hwp_native().unwrap(),
            reloaded.export_hwpx_native().unwrap(),
        ] {
            assert_eq!(
                picture_anchors(&DocumentCore::from_bytes(&saved).unwrap(), 9),
                vec![("A".into(), 6)]
            );
        }
    }
    core.delete_picture_control_native(0, 9, 0).unwrap();
    assert_eq!(picture_anchors(&core, 9), vec![("A".into(), 6)]);
}

#[test]
fn pictures_before_and_after_table_keep_control_data_and_anchors() {
    let (table_core, si, pi) = sample(true);
    let table = table_core.document().sections[si].paragraphs[pi]
        .controls
        .iter()
        .find(|c| matches!(c, Control::Table(_)))
        .unwrap()
        .clone();
    let mut core = table_core;
    let mut doc = core.document().clone();
    while doc.sections[0].paragraphs.len() <= 9 {
        doc.sections[0].paragraphs.push(Default::default());
    }
    let p = &mut doc.sections[0].paragraphs[9];
    p.text = "앞글자뒷글자".into();
    p.char_offsets = vec![0, 1, 2, 11, 12, 13];
    p.char_count = 15;
    p.controls = vec![table];
    p.ctrl_data_records = vec![Some(vec![0, 0, 0, 0])];
    p.char_shapes.truncate(1);
    p.line_segs.truncate(1);
    let before = p.clone();
    core.set_document(doc);
    assert_eq!(named_insert(&mut core, 1, "before"), 0);
    assert_eq!(named_insert(&mut core, 5, "after"), 2);
    let p = &core.document().sections[0].paragraphs[9];
    assert_eq!(p.control_text_positions(), vec![1, 3, 5]);
    assert_eq!(
        p.ctrl_data_records,
        vec![None, before.ctrl_data_records[0].clone(), None]
    );
    for bytes in [
        core.export_hwp_native().unwrap(),
        core.export_hwpx_native().unwrap(),
    ] {
        let mut reloaded = DocumentCore::from_bytes(&bytes).unwrap();
        let p = &reloaded.document().sections[0].paragraphs[9];
        assert_eq!(p.control_text_positions(), vec![1, 3, 5]);
        assert!(matches!(p.controls[1], Control::Table(_)));
        reloaded.delete_picture_control_native(0, 9, 0).unwrap();
        assert_eq!(
            reloaded.document().sections[0].paragraphs[9].control_text_positions(),
            vec![3, 5]
        );
        reloaded.delete_picture_control_native(0, 9, 1).unwrap();
        assert_eq!(
            reloaded.document().sections[0].paragraphs[9].control_text_positions(),
            vec![3]
        );
    }
    core.delete_picture_control_native(0, 9, 0).unwrap();
    core.delete_picture_control_native(0, 9, 1).unwrap();
    let p = &core.document().sections[0].paragraphs[9];
    assert_eq!(p.char_offsets, before.char_offsets);
    assert_eq!(p.ctrl_data_records, before.ctrl_data_records);
    assert_eq!(
        format!("{:?}", p.controls),
        format!("{:?}", before.controls)
    );
}

#[test]
fn hwpx_border_fill_definitions_cover_all_xml_references() {
    use quick_xml::{events::Event, Reader};
    use std::{collections::BTreeSet, io::Read};
    let (core, _, _) = sample(true);
    let bytes = core.export_hwpx_native().unwrap();
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut definitions = BTreeSet::new();
    let mut references = BTreeSet::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        if !file.name().ends_with(".xml") {
            continue;
        }
        let mut xml = String::new();
        file.read_to_string(&mut xml).unwrap();
        let mut reader = Reader::from_str(&xml);
        loop {
            match reader.read_event().unwrap() {
                Event::Start(e) | Event::Empty(e) => {
                    for attr in e.attributes() {
                        let attr = attr.unwrap();
                        let value = attr.unescape_value().unwrap();
                        if e.local_name().as_ref() == b"borderFill" && attr.key.as_ref() == b"id" {
                            assert!(
                                definitions.insert(value.parse::<u32>().unwrap()),
                                "duplicate borderFill ID"
                            );
                        }
                        if attr.key.as_ref() == b"borderFillIDRef" {
                            // Zero is the IR/HWP no-border sentinel, not a resource reference.
                            let id = value.parse::<u32>().unwrap();
                            if id != 0 {
                                references.insert(id);
                            }
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }
    assert!(!references.is_empty());
    assert_eq!(definitions.first(), Some(&1));
    assert!(
        references.is_subset(&definitions),
        "missing references: {:?}",
        references.difference(&definitions).collect::<Vec<_>>()
    );
}

#[test]
fn picture_metadata_survives_hwpx_then_hwp() {
    let mut core = task_paragraph_nine();
    let ci = insert(
        &mut core,
        0,
        9,
        1,
        r#"{"description":"직인 & <원본> \"한글\"","rotationAngle":-30,"horzFlip":true,"vertFlip":true,"width":2400,"height":1800}"#,
    );
    let Control::Picture(before) = &core.document().sections[0].paragraphs[9].controls[ci] else {
        panic!()
    };
    let before = before.clone();
    assert_eq!(
        (
            before.shape_attr.original_width,
            before.shape_attr.original_height
        ),
        (1200, 1200)
    );
    let mut bytes = core.export_hwpx_native().unwrap();
    for _ in 0..2 {
        let reloaded = DocumentCore::from_bytes(&bytes).unwrap();
        let Control::Picture(pic) = &reloaded.document().sections[0].paragraphs[9].controls[ci]
        else {
            panic!()
        };
        assert_eq!(pic.common.description, before.common.description);
        assert_eq!(pic.shape_attr.rotation_angle, -30);
        assert!(pic.shape_attr.horz_flip && pic.shape_attr.vert_flip);
        // flip 의 상위 비트는 회전 저장 플래그다(upstream) — 대칭은 하위 두 비트.
        assert_eq!(pic.shape_attr.flip & 0x3, 3);
        assert_eq!(
            (
                pic.shape_attr.original_width,
                pic.shape_attr.original_height
            ),
            (1200, 1200)
        );
        // 회전 그림의 common 크기는 회전 외접 사각형이다 — 표시 크기는 current_*.
        assert_eq!(
            (pic.shape_attr.current_width, pic.shape_attr.current_height),
            (2400, 1800)
        );
        assert_eq!(
            (pic.common.width, pic.common.height),
            (before.common.width, before.common.height)
        );
        bytes = reloaded.export_hwp_native().unwrap();
    }
}

#[test]
fn invalid_numeric_properties_fail_without_mutation() {
    let mut core = task_paragraph_nine();
    let ci = named_insert(&mut core, 6, "A");
    // 오프셋은 부호 있는 HWPUNIT(i32)이다 — 음수는 유효하고 범위·정수 형식만 검사한다.
    for props in [
        r#"{"vertOffset":2147483648}"#,
        r#"{"horzOffset":-2147483649}"#,
        r#"{"vertOffset":0.5}"#,
        r#"{"width":4294967295}"#,
        r#"{"width":0}"#,
        r#"{"height":-5}"#,
    ] {
        let before = core.export_hwp_native().unwrap();
        let err = core
            .insert_picture_in_paragraph_native(
                0,
                9,
                1,
                &png(),
                1200,
                1200,
                16,
                16,
                "png",
                "",
                props,
            )
            .unwrap_err();
        assert!(err.to_string().contains("E_INVALID"), "{props}: {err}");
        assert_eq!(core.export_hwp_native().unwrap(), before);
        let err = core
            .set_picture_properties_native(0, 9, ci, props)
            .unwrap_err();
        assert!(err.to_string().contains("E_INVALID"), "{props}: {err}");
        assert_eq!(core.export_hwp_native().unwrap(), before);
    }
    core.set_picture_properties_native(0, 9, ci, r#"{"vertOffset":75,"horzOffset":-5000}"#)
        .unwrap();
    let Control::Picture(pic) = &core.document().sections[0].paragraphs[9].controls[ci] else {
        panic!()
    };
    assert_eq!(pic.common.vertical_offset, 75);
    assert_eq!(pic.common.horizontal_offset as i32, -5000);
}

#[test]
fn image_dimensions_are_bounded_before_allocation_for_both_insert_apis() {
    let mut core = task_paragraph_nine();
    let max_px = i32::MAX as u32 / 75;
    for (w, h, nw, nh) in [
        (1200, 1200, max_px + 1, 16),
        (1200, 1200, 16, max_px + 1),
        (1200, 1200, u32::MAX, 16),
        (1200, 1200, 16, u32::MAX),
        (1200, 1200, 0, 16),
        (u32::MAX, 1200, 16, 16),
        (1200, u32::MAX, 16, 16),
        (0, 1200, 16, 16),
    ] {
        let before = core.export_hwp_native().unwrap();
        for legacy in [false, true] {
            let result = if legacy {
                core.insert_picture_native(
                    0,
                    9,
                    1,
                    &[],
                    &png(),
                    w,
                    h,
                    nw,
                    nh,
                    "png",
                    "",
                    None,
                    None,
                )
            } else {
                core.insert_picture_in_paragraph_native(
                    0,
                    9,
                    1,
                    &png(),
                    w,
                    h,
                    nw,
                    nh,
                    "png",
                    "",
                    "",
                )
            };
            assert!(result.unwrap_err().to_string().contains("E_INVALID"));
            assert_eq!(core.export_hwp_native().unwrap(), before);
        }
    }
    // 큰 사진(수천 px)은 정상 입력이다 — 원본 크기에 임의 상한을 두지 않는다.
    core.insert_picture_in_paragraph_native(0, 9, 1, &png(), 1200, 1200, 8000, 6000, "png", "", "")
        .unwrap();
    let Control::Picture(pic) = &core.document().sections[0].paragraphs[9].controls[0] else {
        panic!()
    };
    assert_eq!((pic.crop.right, pic.crop.bottom), (8000 * 75, 6000 * 75));
}

#[test]
fn two_styles_line_boundary_and_multiple_controls_restore_and_resave() {
    let mut core = task_paragraph_nine();
    let mut doc = core.document().clone();
    assert!(doc.doc_info.char_shapes.len() >= 2);
    // Isolate the style/anchor fixture from unrelated sample tables, which trigger
    // the existing HWPX whole-section vertical layout normalization on reload.
    doc.sections.truncate(1);
    for p in &mut doc.sections[0].paragraphs {
        p.controls.clear();
        p.ctrl_data_records.clear();
    }
    let p = &mut doc.sections[0].paragraphs[9];
    p.text = "가😀\t나끝".into();
    p.char_offsets = vec![0, 1, 3, 11, 12];
    p.char_count = 14;
    p.char_shapes = vec![
        CharShapeRef {
            start_pos: 0,
            char_shape_id: 0,
        },
        CharShapeRef {
            start_pos: 11,
            char_shape_id: 1,
        },
    ];
    let first = p.line_segs[0].clone();
    p.line_segs = vec![
        first.clone(),
        LineSeg {
            text_start: 11,
            vertical_pos: 1600,
            ..first
        },
    ];
    let before = p.clone();
    core.set_document(doc);
    assert_eq!(named_insert(&mut core, 4, "A"), 0);
    assert_eq!(named_insert(&mut core, 3, "B"), 0);
    let inserted = core.document().sections[0].paragraphs[9].clone();
    assert_eq!(inserted.control_text_positions(), vec![3, 4]);
    // [#4347] 줄 시작과 같은 위치의 컨트롤은 앞 줄에 든다 — 줄 시작·글자모양 경계가 함께 밀린다.
    assert_eq!(inserted.line_segs[1].text_start, 19);
    assert_eq!(inserted.char_shapes[1].start_pos, 19);
    for bytes in [
        core.export_hwp_native().unwrap(),
        core.export_hwpx_native().unwrap(),
    ] {
        let mut reloaded = DocumentCore::from_bytes(&bytes).unwrap();
        assert_eq!(
            picture_anchors(&reloaded, 9),
            vec![("B".into(), 3), ("A".into(), 4)]
        );
        reloaded.delete_picture_control_native(0, 9, 0).unwrap();
        reloaded.delete_picture_control_native(0, 9, 0).unwrap();
        let p = &reloaded.document().sections[0].paragraphs[9];
        assert_eq!(p.char_offsets, before.char_offsets);
        assert_eq!(
            format!("{:?}", p.char_shapes),
            format!("{:?}", before.char_shapes)
        );
        assert_eq!(
            format!("{:?}", p.line_segs),
            format!("{:?}", before.line_segs)
        );
        for bytes in [
            reloaded.export_hwp_native().unwrap(),
            reloaded.export_hwpx_native().unwrap(),
        ] {
            let saved = DocumentCore::from_bytes(&bytes).unwrap();
            let p = &saved.document().sections[0].paragraphs[9];
            assert_eq!(p.char_offsets, before.char_offsets);
            assert_eq!(
                format!("{:?}", p.char_shapes),
                format!("{:?}", before.char_shapes)
            );
            assert_eq!(
                format!("{:?}", p.line_segs),
                format!("{:?}", before.line_segs)
            );
        }
    }
    core.delete_picture_control_native(0, 9, 0).unwrap();
    core.delete_picture_control_native(0, 9, 0).unwrap();
    let p = &core.document().sections[0].paragraphs[9];
    assert_eq!(
        format!("{:?}", p.char_shapes),
        format!("{:?}", before.char_shapes)
    );
    assert_eq!(
        format!("{:?}", p.line_segs),
        format!("{:?}", before.line_segs)
    );
}

#[test]
fn property_names_in_description_are_not_numeric_properties() {
    let mut core = task_paragraph_nine();
    for key in ["width", "height", "vertOffset", "horzOffset"] {
        named_insert(&mut core, 1, key);
    }
    assert_eq!(
        picture_anchors(&core, 9),
        vec![
            ("width".into(), 1),
            ("height".into(), 1),
            ("vertOffset".into(), 1),
            ("horzOffset".into(), 1)
        ]
    );
}

#[test]
fn hwpx_metadata_without_a_gap_does_not_steal_picture_anchor_or_deletion() {
    let (core, si, pi) = sample(true);
    let mut core = DocumentCore::from_bytes(&core.export_hwpx_native().unwrap()).unwrap();
    let before = core.document().sections[si].paragraphs[pi].clone();
    let ci = insert(&mut core, si, pi, 0, "");
    core.delete_picture_control_native(si, pi, ci).unwrap();
    let p = &core.document().sections[si].paragraphs[pi];
    assert_eq!(p.char_count, before.char_count);
    assert_eq!(p.char_offsets, before.char_offsets);
    assert_eq!(p.control_text_positions(), before.control_text_positions());
}

#[test]
fn deleting_from_a_control_only_paragraph_keeps_line_starts() {
    // 글자·char_offsets 가 없는 문단은 삽입이 좌표를 밀지 않는다 — 삭제도 되돌리지 않아야
    // 줄 시작이 겹치지 않는다.
    let (mut core, si, pi) = sample(false);
    let mut document = core.document().clone();
    let para = &mut document.sections[si].paragraphs[pi];
    para.text.clear();
    para.char_offsets.clear();
    para.controls.clear();
    para.ctrl_data_records.clear();
    para.char_count = 1;
    core.set_document(document);
    for _ in 0..3 {
        insert(&mut core, si, pi, 0, "");
    }
    let mut document = core.document().clone();
    let first = document.sections[si].paragraphs[pi].line_segs[0].clone();
    document.sections[si].paragraphs[pi].line_segs = [0, 8, 16]
        .into_iter()
        .map(|text_start| LineSeg {
            text_start,
            ..first.clone()
        })
        .collect();
    core.set_document(document);
    core.delete_picture_control_native(si, pi, 0).unwrap();
    let starts: Vec<_> = core.document().sections[si].paragraphs[pi]
        .line_segs
        .iter()
        .map(|seg| seg.text_start)
        .collect();
    assert_eq!(starts, vec![0, 8, 16]);
}

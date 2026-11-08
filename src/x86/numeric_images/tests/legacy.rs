use super::*;

#[test]
fn legacy_environment_literal_bytes_classify_tags_before_masking() {
    for (format, expected) in [
        (Format::Protected16, "7b0384a8fdff98ba000044330000"),
        (
            Format::Protected32,
            "7b03000084a80000fdff000098badcfe000023014433221100000000",
        ),
        (Format::Real16, "7b0384a8fdff98ba23c144330020"),
        (
            Format::Real32,
            "7b03000084a80000fdff000098ba000023c1ed0f4433000000201201",
        ),
    ] {
        let before = state();
        let operation = ImageOp {
            kind: Kind::StoreEnvironment,
            format,
        };
        let saved = save(operation, &before, &xmm(), 0xffc5);
        let expected = bytes(expected);
        assert_eq!(&saved.bytes[..expected.len()], expected, "{format:?}");
        let mut after = before;
        after.control_word = 0x37f;
        after.status_word = 0x2804;
        assert_eq!(saved.x87, after);
        assert_eq!(before.tag_word, 0xfffc);
    }
}

#[test]
fn full_legacy_images_store_logical_slots_and_reset_only_the_saved_candidate() {
    for format in [
        Format::Protected16,
        Format::Protected32,
        Format::Real16,
        Format::Real32,
    ] {
        for top in 0..8 {
            let mut before = state();
            before.status_word = 0x8084 | (top << 11);
            let operation = ImageOp {
                kind: Kind::Save,
                format,
            };
            let saved = save(operation, &before, &xmm(), 0xffc5);
            let environment_bytes = operation.width() as usize - 80;
            for logical in 0..8 {
                assert_eq!(
                    &saved.bytes
                        [environment_bytes + logical * 10..environment_bytes + (logical + 1) * 10],
                    &before.registers[(top as usize + logical) & 7]
                );
            }
            let reset = X87State {
                registers: before.registers,
                ..X87State::default()
            };
            assert_eq!(saved.x87, reset);
            assert_eq!(before.status_word, 0x8084 | (top << 11));
        }
    }
}

#[test]
fn environment_restore_uses_existing_physical_payloads_and_derived_summary() {
    let mut image = [0xa5; 512];
    image[..14].copy_from_slice(&bytes("7b03040000003412ffff7856ffff"));
    let before = state();
    let operation = ImageOp {
        kind: Kind::LoadEnvironment,
        format: Format::Protected16,
    };
    let restored = restore(operation, &image, &before, &xmm(), 0xffc5).unwrap();
    assert_eq!(restored.x87.registers, before.registers);
    assert_eq!(restored.x87.control_word, 0x37b);
    assert_eq!(restored.x87.status_word, 0x8084);
    assert_eq!(restored.x87.tag_word, 1);
    assert_eq!(restored.x87.opcode, before.opcode);
    assert_eq!(restored.x87.instruction_pointer, 0x1234);
    assert_eq!(restored.x87.data_pointer, 0x5678);
    assert_eq!(restored.xmm, xmm());
    assert_eq!(restored.mxcsr, 0xffc5);
    image[..2].copy_from_slice(&0x37fu16.to_le_bytes());
    image[2..4].copy_from_slice(&0x8080u16.to_le_bytes());
    let restored = restore(operation, &image, &before, &xmm(), 0xffc5).unwrap();
    assert_eq!(restored.x87.status_word, 0);
}

#[test]
fn legacy_restoration_decodes_independent_real_pointer_packing() {
    for (format, encoded, expected_ip, expected_dp) in [
        (
            Format::Real16,
            "7f038080ffff7856bcda34120090",
            0xd5678,
            0x91234,
        ),
        (
            Format::Real32,
            "7f03ffff8080ffffffffffff7856ffffbcdaed0f3412ffff00209a08",
            0xfedd5678,
            0x89a21234,
        ),
    ] {
        let mut image = [0; 512];
        let encoded = bytes(encoded);
        image[..encoded.len()].copy_from_slice(&encoded);
        let before = state();
        let restored = restore(
            ImageOp {
                kind: Kind::LoadEnvironment,
                format,
            },
            &image,
            &before,
            &xmm(),
            0xffc5,
        )
        .unwrap();
        assert_eq!(restored.x87.instruction_pointer, expected_ip);
        assert_eq!(restored.x87.data_pointer, expected_dp);
        assert_eq!(restored.x87.opcode, 0x2bc);
        assert_eq!(restored.x87.status_word, 0);
        assert_eq!(restored.x87.tag_word, 0xffff);
        assert_eq!(restored.x87.registers, before.registers);
    }
}

#[test]
fn full_legacy_restore_uses_loaded_top_and_classifies_payloads_without_a_save_roundtrip() {
    let raw: [u128; 8] = [
        0,
        0x3fff8000000000000000,
        0x7fffc000000000000123,
        0x7fff8000000000000001,
        0x40000000000000000001,
        0x00008000000000000000,
        0x80000000000000000000,
        0x7fff8000000000000000,
    ];
    let classes = [1, 0, 2, 2, 2, 2, 1, 2];
    for (format, encoded, ip, dp, opcode) in [
        (
            Format::Protected16,
            "7b03040000003412ffff7856ffff",
            0x1234,
            0x5678,
            0x456,
        ),
        (
            Format::Protected32,
            "7b030000040000000000000034120000ffffa5fa78560000ffff0000",
            0x1234,
            0x5678,
            0x2a5,
        ),
        (
            Format::Real16,
            "7b03040000007856bcda34120090",
            0xd5678,
            0x91234,
            0x2bc,
        ),
        (
            Format::Real32,
            "7b03ffff0400ffff0000ffff7856ffffbcdaed0f3412ffff00209a08",
            0xfedd5678,
            0x89a21234,
            0x2bc,
        ),
    ] {
        for top in 0..8 {
            let operation = ImageOp {
                kind: Kind::Restore,
                format,
            };
            let environment_bytes = operation.width() as usize - 80;
            let mut image = [0xa5; 512];
            let encoded = bytes(encoded);
            image[..encoded.len()].copy_from_slice(&encoded);
            let short = environment_bytes == 14;
            let status_at = if short { 2 } else { 4 };
            let tags_at = if short { 4 } else { 8 };
            image[status_at..status_at + 2].copy_from_slice(&(4u16 | top << 11).to_le_bytes());
            image[tags_at..tags_at + 2].copy_from_slice(&0xc0u16.to_le_bytes());
            for (logical, &value) in raw.iter().enumerate() {
                image[environment_bytes + logical * 10..environment_bytes + (logical + 1) * 10]
                    .copy_from_slice(&value.to_le_bytes()[..10]);
            }
            let mut before = state();
            before.opcode = 0x456;
            let result = restore(operation, &image, &before, &xmm(), 0xffc5).unwrap();
            for logical in 0..8 {
                let physical = (top as usize + logical) & 7;
                assert_eq!(result.x87.raw(physical), raw[logical]);
                assert_eq!(
                    result.x87.tag(physical),
                    if physical == 3 { 3 } else { classes[logical] }
                );
            }
            assert_eq!(result.x87.control_word, 0x37b);
            assert_eq!(result.x87.status_word, 0x8084 | top << 11);
            assert_eq!(result.x87.instruction_pointer, ip);
            assert_eq!(result.x87.data_pointer, dp);
            assert_eq!(result.x87.opcode, opcode);
            assert_eq!(result.xmm, xmm());
            assert_eq!(result.mxcsr, 0xffc5);
            assert_eq!(result.x87.validate(), Ok(()));
        }
    }
}

#[test]
fn legacy_save_spans_omit_wholly_reserved_bytes_and_cover_all_payload_slots() {
    for format in [
        Format::Protected16,
        Format::Protected32,
        Format::Real16,
        Format::Real32,
    ] {
        for kind in [Kind::StoreEnvironment, Kind::Save] {
            let operation = ImageOp { kind, format };
            let mut actual = [false; 108];
            for &(start, length) in operation.spans() {
                actual[start as usize..(start + length) as usize].fill(true);
            }
            let width = operation.width() as usize;
            let expected: [bool; 108] = std::array::from_fn(|byte| {
                byte < width
                    && match format {
                        Format::Protected32 => !matches!(byte, 2 | 3 | 6 | 7 | 10 | 11 | 26 | 27),
                        Format::Real32 => {
                            !matches!(byte, 2 | 3 | 6 | 7 | 10 | 11 | 14 | 15 | 22 | 23)
                        }
                        _ => true,
                    }
            });
            assert_eq!(actual, expected, "{operation:?}");
        }
    }
}

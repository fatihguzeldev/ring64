use super::*;

#[test]
fn fx_save_literals_keep_physical_ftw_and_logical_raw_slots_separate() {
    for format in [Format::FxLegacy, Format::Fx64, Format::Fx64Wide] {
        let before = state();
        let operation = ImageOp {
            kind: Kind::SaveFx,
            format,
        };
        let saved = save(operation, &before, &xmm(), 0xffc5);
        assert_eq!(&saved.bytes[..8], &bytes("7b0384a801002301"));
        assert_eq!(&saved.bytes[8..12], &bytes("98badcfe"));
        assert_eq!(&saved.bytes[16..20], &bytes("44332211"));
        assert_eq!(&saved.bytes[24..32], &bytes("c5ff0000ffff0000"));
        if format == Format::Fx64Wide {
            assert_eq!(&saved.bytes[12..16], &bytes("78563412"));
            assert_eq!(&saved.bytes[20..24], &bytes("55667788"));
        } else {
            assert_eq!(&saved.bytes[12..16], &[0; 4]);
            assert_eq!(&saved.bytes[20..24], &[0; 4]);
        }
        for logical in 0..8 {
            assert_eq!(
                &saved.bytes[32 + 16 * logical..42 + 16 * logical],
                &before.registers[(5 + logical) & 7]
            );
        }
        for bank in 0..operation.xmm_count() {
            assert_eq!(&saved.bytes[160 + 16 * bank..176 + 16 * bank], &xmm()[bank]);
        }
        assert_eq!(saved.x87, before);
    }
}

#[test]
fn fx_restore_literals_normalize_summaries_and_classify_loaded_physical_payloads() {
    let raw: [u128; 8] = [
        0,
        0xbad,
        0x3fff8000000000000000,
        0x7fff8000000000000011,
        0x80000000000000000000,
        0x40000000000000000001,
        0x00008000000000000000,
        0xffffffffffffffffffff,
    ];
    for format in [Format::FxLegacy, Format::Fx64, Format::Fx64Wide] {
        let operation = ImageOp {
            kind: Kind::RestoreFx,
            format,
        };
        let mut image = [0xa5; 512];
        image[0..2].copy_from_slice(&0x37bu16.to_le_bytes());
        image[2..4].copy_from_slice(&0x2804u16.to_le_bytes());
        image[4] = 0x25;
        image[6..8].copy_from_slice(&0xfa55u16.to_le_bytes());
        image[8..16].copy_from_slice(&0x1122334455667788u64.to_le_bytes());
        image[16..24].copy_from_slice(&0x99aabbccddeeff00u64.to_le_bytes());
        image[24..28].copy_from_slice(&0xffc5u32.to_le_bytes());
        image[28..32].fill(0xff);
        for logical in 0..8 {
            image[32 + logical * 16..42 + logical * 16]
                .copy_from_slice(&raw[(5 + logical) & 7].to_le_bytes()[..10]);
        }
        for bank in 0..16 {
            image[160 + 16 * bank..176 + 16 * bank].fill(0xf0 ^ bank as u8);
        }
        let before = state();
        let restored = restore(operation, &image, &before, &xmm(), 0x1f80).unwrap();
        for (physical, &value) in raw.iter().enumerate() {
            assert_eq!(restored.x87.raw(physical), value);
        }
        assert_eq!(restored.x87.tag_word, 0xfbcd);
        assert_eq!(restored.x87.status_word, 0xa884);
        assert_eq!(restored.x87.control_word, 0x37b);
        assert_eq!(restored.x87.opcode, 0x255);
        assert_eq!(
            restored.x87.instruction_pointer,
            if format == Format::Fx64Wide {
                0x1122334455667788
            } else {
                0x55667788
            }
        );
        assert_eq!(
            restored.x87.data_pointer,
            if format == Format::Fx64Wide {
                0x99aabbccddeeff00
            } else {
                0xddeeff00
            }
        );
        for bank in 0..16 {
            assert_eq!(
                restored.xmm[bank],
                if bank < operation.xmm_count() {
                    [0xf0 ^ bank as u8; 16]
                } else {
                    xmm()[bank]
                }
            );
        }
        assert_eq!(restored.mxcsr, 0xffc5);
        assert_eq!(restored.x87.validate(), Ok(()));
    }
}

#[test]
fn fx_restore_does_not_trust_the_image_mxcsr_mask() {
    let operation = ImageOp {
        kind: Kind::RestoreFx,
        format: Format::Fx64Wide,
    };
    let mut image = [0; 512];
    image[28..32].fill(0xff);
    for value in [0x10000u32, 0x80000000, u32::MAX] {
        image[24..28].copy_from_slice(&value.to_le_bytes());
        assert!(
            matches!(restore(operation, &image, &state(), &xmm(), 0x1f80), Err(actual) if actual == value)
        );
    }
}

#[test]
fn fx_field_spans_preserve_all_padding_inactive_banks_and_software_bytes() {
    for format in [Format::FxLegacy, Format::Fx64, Format::Fx64Wide] {
        let operation = ImageOp {
            kind: Kind::SaveFx,
            format,
        };
        let mut actual = [false; 512];
        for &(start, length) in operation.spans() {
            actual[start as usize..(start + length) as usize].fill(true);
        }
        let expected: [bool; 512] = std::array::from_fn(|byte| match byte {
            0..=4 | 6..=13 | 16..=21 | 24..=31 | 160..=287 => true,
            14..=15 | 22..=23 => format == Format::Fx64Wide,
            32..=159 => (byte - 32) % 16 < 10,
            288..=415 => format != Format::FxLegacy,
            _ => false,
        });
        assert_eq!(actual, expected, "{format:?}");
    }
}

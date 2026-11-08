use super::*;
use crate::x86::context::{ExecutionContext, Mode};
use crate::x86::mmx::{Kind, Op};
use crate::x86::numeric_images::{Format, Kind as ImageKind};

fn mmx(code: &[u8]) -> Op {
    let Operation::Mmx { op, .. } = operation(code) else {
        panic!("expected MMX {code:02x?}")
    };
    assert_eq!(Op::try_decode(op.encode()), Some(op), "{code:02x?}");
    op
}

#[test]
fn selected_mmx_and_numeric_image_forms_are_decoded() {
    for code in [
        &[0x0f, 0x6e, 0xc1][..],
        &[0x48, 0x0f, 0x7e, 0xc1],
        &[0x0f, 0x6f, 0xc1],
        &[0x0f, 0x7f, 0x03],
        &[0x0f, 0xfc, 0xc1],
        &[0x0f, 0x70, 0xc1, 0x1b],
        &[0x0f, 0x71, 0xd0, 0xff],
        &[0x0f, 0xc4, 0xc1, 5],
        &[0x0f, 0xc5, 0xc1, 5],
        &[0x0f, 0xd7, 0xc1],
        &[0xf2, 0x0f, 0xd6, 0xc1],
        &[0xf3, 0x0f, 0xd6, 0xc1],
        &[0x0f, 0x77],
        &[0x0f, 0x2a, 0xc1],
        &[0x66, 0x0f, 0x2a, 0x03],
        &[0x0f, 0x2c, 0xc1],
        &[0x66, 0x0f, 0x2d, 0x03],
        &[0xd9, 0x20],
        &[0xd9, 0x30],
        &[0xdd, 0x20],
        &[0xdd, 0x30],
        &[0x0f, 0xae, 0x00],
        &[0x48, 0x0f, 0xae, 0x08],
    ] {
        assert!(at(0x1000, code).is_ok(), "{code:02x?}");
    }
}

#[test]
fn mmx_register_only_forms_reject_memory_before_address_tails() {
    for code in [
        &[0x0f, 0x71, 0x14][..],
        &[0x0f, 0xc5, 0x04],
        &[0x0f, 0xd7, 0x04],
        &[0xf2, 0x0f, 0xd6, 0x04],
        &[0xf3, 0x0f, 0xd6, 0x04],
        &[0x0f, 0xae, 0xc0],
        &[0x0f, 0xae, 0xc8],
    ] {
        assert_eq!(at(0x1000, code), Err(DecodeError::Invalid), "{code:02x?}");
    }
    for prefix in [0x66, 0xf2, 0xf3] {
        assert_eq!(
            at(0x1000, &[prefix, 0x0f, 0xae, 0x00]),
            Err(DecodeError::Unsupported)
        );
    }
}

#[test]
fn mmx_rex_bits_extend_only_actual_gpr_and_xmm_fields() {
    for (code, kind, dst, src, wide) in [
        (&[0x4f, 0x0f, 0x6f, 0xc7][..], Kind::Move, 0, 7, false),
        (&[0x4f, 0x0f, 0x6e, 0xc7], Kind::FromGpr, 0, 15, true),
        (&[0x4f, 0x0f, 0x7e, 0xc7], Kind::ToGpr, 15, 0, true),
        (&[0x4f, 0x0f, 0xc5, 0xc7, 5], Kind::ExtractWord, 8, 7, false),
        (&[0xf2, 0x4f, 0x0f, 0xd6, 0xc7], Kind::FromXmm, 0, 15, false),
        (&[0xf3, 0x4f, 0x0f, 0xd6, 0xc7], Kind::ToXmm, 8, 7, false),
        (&[0x4f, 0x0f, 0x2a, 0xc7], Kind::PiToPs, 8, 7, false),
        (&[0x66, 0x4f, 0x0f, 0x2d, 0xc7], Kind::PdToPi, 0, 15, false),
    ] {
        let op = mmx(code);
        assert_eq!((op.kind, op.dst, op.src, op.wide), (kind, dst, src, wide));
    }
    assert_eq!(
        (mmx(&[0x0f, 0x7f, 0xc7]).dst, mmx(&[0x0f, 0x7f, 0xc7]).src),
        (7, 0)
    );
    let shift = mmx(&[0x4f, 0x0f, 0x71, 0xf7, 0xff]);
    assert_eq!(
        (shift.dst, shift.src, shift.immediate, shift.immediate_count),
        (7, 0, 255, true)
    );
    for (code, bytes) in [
        (&[0x0f, 0x7e, 0x03][..], 4),
        (&[0x48, 0x0f, 0x7e, 0x03], 8),
        (&[0x0f, 0x7f, 0x03], 8),
        (&[0x0f, 0xc4, 0x03, 5], 2),
    ] {
        assert_eq!(mmx(code).memory_bytes(), bytes);
    }
}

#[test]
fn every_selected_mmx_lane_opcode_roundtrips_and_keeps_exact_memory_widths() {
    let opcodes = [
        0xdb, 0xdf, 0xeb, 0xef, 0xfc, 0xfd, 0xfe, 0xd4, 0xf8, 0xf9, 0xfa, 0xfb, 0xec, 0xed, 0xdc,
        0xdd, 0xe8, 0xe9, 0xd8, 0xd9, 0x74, 0x75, 0x76, 0x64, 0x65, 0x66, 0xda, 0xde, 0xea, 0xee,
        0xe0, 0xe3, 0xd5, 0xe5, 0xe4, 0xf4, 0xf5, 0xf6, 0x63, 0x6b, 0x67, 0x60, 0x61, 0x62, 0x68,
        0x69, 0x6a, 0xd1, 0xd2, 0xd3, 0xe1, 0xe2, 0xf1, 0xf2, 0xf3,
    ];
    for opcode in opcodes {
        for dst in 0..8 {
            for src in 0..8 {
                let op = mmx(&[0x4f, 0x0f, opcode, 0xc0 | (dst << 3) | src]);
                assert_eq!((op.dst, op.src, op.memory), (dst, src, false));
            }
        }
        assert_eq!(mmx(&[0x0f, opcode, 3]).memory_bytes(), 8);
        assert_eq!(
            at(0x1000, &[0xf0, 0x0f, opcode, 0xc1]),
            Err(DecodeError::Invalid)
        );
    }
    for opcode in [0x6c, 0x6d, 0x0f] {
        assert_eq!(
            at(0x1000, &[0x0f, opcode, 0xc1]),
            Err(DecodeError::Unsupported)
        );
    }
}

#[test]
fn image_sizes_follow_all_imported_profiles_and_effective_prefix_order() {
    let mut contexts = vec![ExecutionContext::default()];
    for mode in ["real", "protected", "compatibility"] {
        for code32 in [false, true] {
            for stack32 in [false, true] {
                let mut segments = serde_json::Map::new();
                for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
                    segments.insert(name.into(), serde_json::json!({
                        "base":"0x0", "limit":u32::MAX, "default32":if name == "ss" {stack32} else {code32},
                        "usable":true,"type":if name == "cs" {"readable-code"} else {"read-write"}
                    }));
                }
                contexts.push(
                    ExecutionContext::from_json(
                        &serde_json::json!({"mode":mode,"segments":segments}),
                    )
                    .unwrap(),
                );
            }
        }
    }
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(name.into(), serde_json::json!({"base":"0x0","limit":0xffff,"default32":false,"usable":true,"type":"read-write"}));
    }
    contexts.push(
        ExecutionContext::from_json(&serde_json::json!({"mode":"virtual8086","segments":segments}))
            .unwrap(),
    );
    assert_eq!(contexts.len(), 14);
    for context in &contexts {
        for prefix in [vec![], vec![0x66]] {
            for (opcode, modrm, kind, full) in [
                (0xd9, 0x20, ImageKind::LoadEnvironment, false),
                (0xd9, 0x30, ImageKind::StoreEnvironment, false),
                (0xdd, 0x20, ImageKind::Restore, true),
                (0xdd, 0x30, ImageKind::Save, true),
            ] {
                let mut code = prefix.clone();
                code.extend([opcode, modrm]);
                let decoded = super::super::decode_with_context(0x1000, context, |pc| {
                    Ok(code[(pc - 0x1000) as usize])
                })
                .unwrap();
                let Operation::NumericImage { op, .. } = decoded.operation else {
                    panic!("image")
                };
                let short = (!context.is_long64() && !context.code32()) != !prefix.is_empty();
                let real = matches!(context.mode(), Mode::Real | Mode::Virtual8086);
                assert_eq!(op.kind, kind);
                assert_eq!(
                    op.width(),
                    if short { 14 } else { 28 } + if full { 80 } else { 0 }
                );
                assert_eq!(
                    op.format,
                    match (real, short) {
                        (true, true) => Format::Real16,
                        (true, false) => Format::Real32,
                        (false, true) => Format::Protected16,
                        (false, false) => Format::Protected32,
                    }
                );
            }
        }
    }
    for (code, width) in [
        (&[0x66, 0x48, 0xd9, 0x20][..], 28),
        (&[0x48, 0x66, 0xd9, 0x20], 14),
        (&[0x66, 0x48, 0xdd, 0x30], 108),
        (&[0x48, 0x66, 0xdd, 0x30], 94),
    ] {
        let Operation::NumericImage { op, .. } = operation(code) else {
            panic!("image")
        };
        assert_eq!(op.width(), width);
    }
}

#[test]
fn required_mmx_and_image_tails_precede_lock_rejection() {
    for full in [
        &[0x0f, 0x70, 0x84, 0x24, 1, 2, 3, 4, 0xff][..],
        &[0xf0, 0x0f, 0xc4, 0x84, 0x24, 1, 2, 3, 4, 0xff],
        &[0xf0, 0x0f, 0xae, 0x84, 0x24, 1, 2, 3, 4],
        &[0xf0, 0xdd, 0xb4, 0x24, 1, 2, 3, 4],
    ] {
        for end in 1..full.len() {
            assert_eq!(
                at(0x1000, &full[..end]),
                Err(DecodeError::Fetch(missing(0x1000 + end as u64))),
                "{full:02x?} {end}"
            );
        }
        if full[0] == 0xf0 {
            assert_eq!(at(0x1000, full), Err(DecodeError::Invalid));
        } else {
            assert!(at(0x1000, full).is_ok());
        }
    }
}

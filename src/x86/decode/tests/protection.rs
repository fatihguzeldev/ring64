use super::*;
use crate::x86::context::Segment;
use crate::x86::instruction::{
    Location, ProtectionDescriptor, ProtectionInstruction, ProtectionKind,
};

#[test]
fn protection_private_descriptor_roundtrips_selected_shapes_and_rejects_reserved_fields() {
    for (kind, width, memory) in [
        (ProtectionKind::StoreGdt, Width::W64, true),
        (ProtectionKind::LoadLdt, Width::W16, false),
        (ProtectionKind::ReadSegment(Segment::Cs), Width::W32, false),
        (ProtectionKind::LoadSegment(Segment::Fs), Width::W16, true),
        (ProtectionKind::LoadFar(Segment::Ss), Width::W64, true),
        (ProtectionKind::Lar, Width::W16, false),
        (ProtectionKind::Verw, Width::W16, true),
    ] {
        let op = ProtectionDescriptor {
            kind,
            width,
            memory,
        };
        assert_eq!(ProtectionDescriptor::try_decode(op.encode()), Some(op));
        assert_eq!(ProtectionDescriptor::try_decode(op.encode() | 256), None);
    }
}

#[test]
fn descriptor_and_segment_forms_decode_literal_register_ownership_and_fixed_widths() {
    assert_eq!(
        operation(&[0x4c, 0x8c, 0xc1]),
        Operation::Protection(ProtectionInstruction {
            kind: ProtectionKind::ReadSegment(Segment::Es),
            operand: Location::Register(RegisterView::low(1)),
            register: 0,
            width: Width::W64,
        })
    );
    assert_eq!(
        operation(&[0x4d, 0x0f, 0x02, 0xc1]),
        Operation::Protection(ProtectionInstruction {
            kind: ProtectionKind::Lar,
            operand: Location::Register(RegisterView::low(9)),
            register: 8,
            width: Width::W64,
        })
    );
    assert!(matches!(
        operation(&[0x0f, 0x01, 0x10]),
        Operation::Protection(ProtectionInstruction {
            kind: ProtectionKind::LoadGdt,
            width: Width::W64,
            operand: Location::Memory(_),
            ..
        })
    ));
}

fn contextual(bytes: &[u8], mode: &str, code32: bool) -> Result<Instruction, DecodeError> {
    let segments = ["cs", "ss", "ds", "es", "fs", "gs"].into_iter().map(|name| {
        (name.to_owned(), serde_json::json!({"base":"0x0", "limit":if mode == "virtual8086" {0xffffu32} else {u32::MAX},
            "default32":code32, "usable":true, "type":if name == "cs" && mode != "virtual8086" {"readable-code"} else {"read-write"}}))
    }).collect::<serde_json::Map<_,_>>();
    let context = crate::x86::context::ExecutionContext::from_json(
        &serde_json::json!({"mode":mode,"segments":segments}),
    )
    .unwrap();
    super::super::decode_with_context(0x1000, &context, |pc| {
        bytes
            .get(pc.wrapping_sub(0x1000) as usize)
            .copied()
            .ok_or(DecodeError::Fetch(missing(pc)))
    })
}

#[test]
fn protection_selected_cohort_preserves_operand_sizes_and_mode_legality() {
    for (bytes, kind) in [
        (&[0x0f, 0x01, 0x00][..], ProtectionKind::StoreGdt),
        (&[0x0f, 0x01, 0x08][..], ProtectionKind::StoreIdt),
        (&[0x0f, 0x01, 0x10][..], ProtectionKind::LoadGdt),
        (&[0x0f, 0x01, 0x18][..], ProtectionKind::LoadIdt),
        (&[0x0f, 0x00, 0xc0][..], ProtectionKind::ReadLdt),
        (&[0x0f, 0x00, 0xd0][..], ProtectionKind::LoadLdt),
        (&[0x8c, 0xd8][..], ProtectionKind::ReadSegment(Segment::Ds)),
        (&[0x8e, 0xe0][..], ProtectionKind::LoadSegment(Segment::Fs)),
        (&[0xc4, 0x00][..], ProtectionKind::LoadFar(Segment::Es)),
        (&[0xc5, 0x00][..], ProtectionKind::LoadFar(Segment::Ds)),
        (
            &[0x0f, 0xb2, 0x00][..],
            ProtectionKind::LoadFar(Segment::Ss),
        ),
        (
            &[0x0f, 0xb4, 0x00][..],
            ProtectionKind::LoadFar(Segment::Fs),
        ),
        (
            &[0x0f, 0xb5, 0x00][..],
            ProtectionKind::LoadFar(Segment::Gs),
        ),
        (&[0x0f, 0x02, 0xc0][..], ProtectionKind::Lar),
        (&[0x0f, 0x03, 0xc0][..], ProtectionKind::Lsl),
        (&[0x0f, 0x00, 0xe0][..], ProtectionKind::Verr),
        (&[0x0f, 0x00, 0xe8][..], ProtectionKind::Verw),
    ] {
        for code32 in [false, true] {
            let instruction = contextual(bytes, "protected", code32).unwrap();
            assert_eq!(instruction.encoded_len(), bytes.len() as u32);
            let Operation::Protection(op) = instruction.operation else {
                panic!("not protection")
            };
            assert_eq!(op.kind, kind);
            let fixed = matches!(
                kind,
                ProtectionKind::LoadLdt
                    | ProtectionKind::LoadSegment(_)
                    | ProtectionKind::Verr
                    | ProtectionKind::Verw
            );
            assert_eq!(
                op.width,
                if fixed || !code32 {
                    Width::W16
                } else {
                    Width::W32
                }
            );
            let mut override_bytes = vec![0x66];
            override_bytes.extend(bytes);
            let Operation::Protection(overridden) =
                contextual(&override_bytes, "protected", code32)
                    .unwrap()
                    .operation
            else {
                panic!("override")
            };
            assert_eq!(
                overridden.width,
                if fixed || code32 {
                    Width::W16
                } else {
                    Width::W32
                }
            );
        }
    }
    for bytes in [
        &[0x0f, 0x00, 0xc0][..],
        &[0x0f, 0x00, 0xd0],
        &[0x0f, 0x02, 0xc0],
        &[0x0f, 0x03, 0xc0],
        &[0x0f, 0x00, 0xe0],
        &[0x0f, 0x00, 0xe8],
    ] {
        for mode in ["real", "virtual8086"] {
            assert_eq!(contextual(bytes, mode, false), Err(DecodeError::Invalid));
        }
    }
}

#[test]
fn protection_neighbors_and_invalid_classes_stop_at_their_deciding_modrm() {
    for bytes in [
        &[0xc4, 0xc0][..],
        &[0xc5, 0xf8],
        &[0x0f, 0x01, 0xc1],
        &[0x0f, 0x01, 0xd0],
        &[0x0f, 0x00, 0xc8],
        &[0x0f, 0x00, 0xd8],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Unsupported));
    }
    for bytes in [
        &[0x8e, 0x0c][..],
        &[0x8c, 0x34],
        &[0x8e, 0x3c],
        &[0x0f, 0xb2, 0xc0],
        &[0x0f, 0xb4, 0xc0],
        &[0x0f, 0xb5, 0xc0],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Invalid));
    }
    assert_eq!(
        contextual(&[0xc5, 0xf8], "protected", true),
        Err(DecodeError::Unsupported)
    );
    assert_eq!(at(0x1000, &[0xc5]), Err(DecodeError::Unsupported));
}

#[test]
fn protection_required_tails_precede_single_lock_and_selected_mode_failures() {
    let complete = [0xf0, 0x0f, 0x02, 0x84, 0x8b, 0x78, 0x56, 0x34, 0x12];
    for len in 1..complete.len() {
        assert!(
            matches!(at(0x1000, &complete[..len]), Err(DecodeError::Fetch(_))),
            "length{len}"
        );
    }
    assert_eq!(at(0x1000, &complete), Err(DecodeError::Invalid));
    let mode = [0x0f, 0x00, 0x96, 0x34, 0x12];
    for len in 1..mode.len() {
        assert!(
            matches!(
                contextual(&mode[..len], "real", false),
                Err(DecodeError::Fetch(_))
            ),
            "mode length{len}"
        );
    }
    assert_eq!(contextual(&mode, "real", false), Err(DecodeError::Invalid));
    assert_eq!(
        at(0x1000, &[0xf0, 0xf0, 0x8c, 0xc0]),
        Err(DecodeError::Unsupported)
    );
}

#[test]
fn protection_prefix_order_and_rex_roles_are_independent_for_each_operand() {
    for (bytes, kind, width, operand, register) in [
        (
            &[0x45, 0x8e, 0xe0][..],
            ProtectionKind::LoadSegment(Segment::Fs),
            Width::W16,
            8,
            0,
        ),
        (
            &[0x4c, 0x0f, 0x00, 0xd0][..],
            ProtectionKind::LoadLdt,
            Width::W16,
            0,
            0,
        ),
        (
            &[0x66, 0x4d, 0x0f, 0x03, 0xc1][..],
            ProtectionKind::Lsl,
            Width::W64,
            9,
            8,
        ),
        (
            &[0x4d, 0x66, 0x0f, 0x03, 0xc1][..],
            ProtectionKind::Lsl,
            Width::W16,
            1,
            0,
        ),
        (
            &[0xf2, 0xf3, 0x8c, 0xe8][..],
            ProtectionKind::ReadSegment(Segment::Gs),
            Width::W32,
            0,
            0,
        ),
        (
            &[0x49, 0x0f, 0x00, 0xc0][..],
            ProtectionKind::ReadLdt,
            Width::W64,
            8,
            0,
        ),
    ] {
        assert_eq!(
            operation(bytes),
            Operation::Protection(ProtectionInstruction {
                kind,
                width,
                register,
                operand: Location::Register(RegisterView::low(operand))
            })
        );
    }
    let Operation::Protection(read) = operation(&[0x48, 0x8c, 0x03]) else {
        panic!("memory segment read")
    };
    assert_eq!(read.width, Width::W16);
    let Operation::Protection(table) = operation(&[0x66, 0x4d, 0x0f, 0x01, 0x10]) else {
        panic!("table")
    };
    assert_eq!(
        (table.kind, table.width),
        (ProtectionKind::LoadGdt, Width::W64)
    );
    assert!(matches!(
        table.operand,
        Location::Memory(Address {
            base: AddressBase::Register(8),
            ..
        })
    ));
    let mut exact = vec![0x66; 12];
    exact.extend([0x0f, 0x02, 0xc0]);
    assert_eq!(at(0x1000, &exact).unwrap().encoded_len(), 15);
    exact.insert(0, 0x66);
    assert_eq!(at(0x1000, &exact), Err(DecodeError::Invalid));
}

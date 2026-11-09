use super::*;
use crate::x86::instruction::{Location, ProtectionInstruction, ProtectionKind};

#[test]
fn task_selector_forms_pin_fixed_load_and_store_memory_widths_and_rex_b() {
    for (bytes, kind, width, register) in [
        (
            &[0x0f, 0x00, 0xc8][..],
            ProtectionKind::ReadTask,
            Width::W32,
            0,
        ),
        (
            &[0x66, 0x0f, 0x00, 0xc8],
            ProtectionKind::ReadTask,
            Width::W16,
            0,
        ),
        (
            &[0x4d, 0x0f, 0x00, 0xc8],
            ProtectionKind::ReadTask,
            Width::W64,
            8,
        ),
        (
            &[0x4d, 0x0f, 0x00, 0xd8],
            ProtectionKind::LoadTask,
            Width::W16,
            8,
        ),
    ] {
        assert_eq!(
            operation(bytes),
            Operation::Protection(ProtectionInstruction {
                kind,
                width,
                register: 0,
                operand: Location::Register(RegisterView::low(register)),
            })
        );
    }
    let Operation::Protection(p) = operation(&[0xf3, 0x48, 0x0f, 0x00, 0x08]) else {
        panic!("STR")
    };
    assert_eq!(p.kind, ProtectionKind::ReadTask);
    assert_eq!(p.width, Width::W16);
    assert!(matches!(p.operand, Location::Memory(_)));
    for kind in [ProtectionKind::ReadTask, ProtectionKind::LoadTask] {
        for width in [Width::W16, Width::W32, Width::W64] {
            let p = crate::x86::instruction::ProtectionDescriptor {
                kind,
                width,
                memory: false,
            };
            assert_eq!(
                crate::x86::instruction::ProtectionDescriptor::try_decode(p.encode()).is_some(),
                kind == ProtectionKind::ReadTask || width == Width::W16
            );
        }
    }
}

#[test]
fn task_selector_selected_tails_precede_lock_invalidity() {
    let bytes = [0xf0, 0x0f, 0x00, 0x9c, 0x8b, 0x78, 0x56, 0x34, 0x12];
    for length in 1..bytes.len() {
        assert!(
            matches!(at(0x1000, &bytes[..length]), Err(DecodeError::Fetch(_))),
            "length{length}"
        );
    }
    assert_eq!(at(0x1000, &bytes), Err(DecodeError::Invalid));
    assert_eq!(
        at(0x1000, &[0x0f, 0x00, 0xf0]),
        Err(DecodeError::Unsupported)
    );
}

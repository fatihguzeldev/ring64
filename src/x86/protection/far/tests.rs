use super::*;
use crate::memory::{MappingInput, MemoryLimits, Permissions};
use crate::x86::context::{Mode, TableRegister};
use crate::x86::instruction::FarKind;

pub(super) fn image() -> Image {
    Image::mapped(
        vec![("ram".into(), vec![0; 0x11000])],
        vec![MappingInput {
            base: 0,
            backing: "ram".into(),
            offset: 0,
            length: 0x11000,
            permissions: Permissions {
                read: true,
                write: true,
                execute: true,
            },
        }],
        MemoryLimits {
            max_backing_bytes: 0x11000,
            max_backings: 1,
            max_mappings: 16,
        },
    )
    .unwrap()
}

pub(super) fn context(mode: &str, cpl: u8) -> ExecutionContext {
    let mut context = super::super::tests::context(mode, cpl);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 0x3f,
    });
    context
}

pub(super) fn run(
    context: &mut ExecutionContext,
    image: &mut Image,
    kind: FarKind,
    width: Width,
    target: (u64, u16),
    sp: u64,
) -> Result<FarOutcome, FarFailure> {
    let (mut offset, selector) = target;
    let memory = context.is_long64() && kind != FarKind::Return;
    if memory {
        let count = width.bytes() as usize;
        let mut bytes = [0; 10];
        bytes[..count].copy_from_slice(&offset.to_le_bytes()[..count]);
        bytes[count..count + 2].copy_from_slice(&selector.to_le_bytes());
        image.write_bytes(0x1100, &bytes[..count + 2]).unwrap();
        offset = 0x1100;
    }
    execute(
        context,
        image,
        FarDescriptor {
            kind,
            width,
            memory,
        },
        FarOperands {
            offset,
            selector,
            input_sp: sp,
            next_pc: 0x1234,
            segment: Segment::Ds,
        },
    )
}

#[test]
fn same_selector_jump_reloads_execute_only_code_and_sets_exact_accessed_byte() {
    let mut context = context("long64", 0);
    let mut image = image();
    image.write(0x1008, 8, 0x00af_9800_3000_ffff).unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Jump,
        Width::W32,
        (0x2000, 8),
        0x4000,
    )
    .unwrap();
    assert_eq!(
        outcome,
        FarOutcome {
            pc: 0x2000,
            sp: 0x4000,
            context_changed: true
        }
    );
    assert_eq!(context.mode(), Mode::Long64);
    assert_eq!(context.segment(Segment::Cs).base, 0x3000);
    assert_eq!(
        context.segment(Segment::Cs).kind,
        crate::x86::context::SegmentType::Code
    );
    assert_eq!(context.selector(Segment::Cs), 8);
    assert!(context.attributes(Segment::Cs).accessed);
    assert_eq!(image.read(0x1008, 8).unwrap(), 0x00af_9900_3000_ffff);
}

#[test]
fn far_call_uses_full_operand_sized_selector_slots_and_matching_return() {
    for (width, next_sp, offset_address, selector_address) in [
        (Width::W16, 0x401c, 0x401c, 0x401e),
        (Width::W32, 0x4018, 0x4018, 0x401c),
        (Width::W64, 0x4010, 0x4010, 0x4018),
    ] {
        let mut context = context("long64", 0);
        let mut image = image();
        image.write(0x1008, 8, 0x00af_9b00_0000_ffff).unwrap();
        let outcome = run(
            &mut context,
            &mut image,
            FarKind::Call,
            width,
            (0x2000, 8),
            0x4020,
        )
        .unwrap();
        assert_eq!(outcome.pc, 0x2000);
        assert_eq!(outcome.sp, next_sp);
        assert_eq!(
            image
                .read(offset_address, u32::from(width.bytes()))
                .unwrap(),
            0x1234
        );
        assert_eq!(
            image
                .read(selector_address, u32::from(width.bytes()))
                .unwrap(),
            8
        );
        let returned = run(
            &mut context,
            &mut image,
            FarKind::Return,
            width,
            (0, 0),
            next_sp,
        )
        .unwrap();
        assert_eq!(returned.pc, 0x1234);
        assert_eq!(returned.sp, 0x4020);
    }
}

#[test]
fn compatibility_call_truncates_wide_offset_but_jump_and_return_do_not() {
    for kind in [FarKind::Call, FarKind::Jump, FarKind::Return] {
        let mut context = context("long64", 0);
        let original = context.clone();
        let mut image = image();
        image.write(0x1008, 8, 0x00cf_9b00_0000_ffff).unwrap();
        image.write(0x4000, 8, 0x1_0000_2000).unwrap();
        image.write(0x4008, 8, 8).unwrap();
        let result = run(
            &mut context,
            &mut image,
            kind,
            Width::W64,
            (0x1_0000_2000, 8),
            0x4000,
        );
        if kind == FarKind::Call {
            assert_eq!(result.unwrap().pc, 0x2000);
            assert_eq!(context.mode(), Mode::Compatibility);
        } else {
            assert!(matches!(
                result,
                Err(FarFailure::Protection(super::super::ProtectionFault {
                    vector: 13,
                    error_code: 0,
                    ..
                }))
            ));
            assert_eq!(context, original);
        }
    }
}

#[test]
fn outer_return_skips_unread_parameters_and_restores_target_width_pointer() {
    let mut context = context("long64", 0);
    let mut image = image();
    image.write(0x1018, 8, 0x00af_fb00_0000_ffff).unwrap();
    image.write(0x1020, 8, 0x00cf_f300_0000_ffff).unwrap();
    image.write(0x4000, 8, 0x2000).unwrap();
    image.write(0x4008, 8, 0x1b).unwrap();
    image.write(0x4020, 8, 0x5000).unwrap();
    image.write(0x4028, 8, 0x23).unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Return,
        Width::W64,
        (0x10, 0),
        0x4000,
    )
    .unwrap();
    assert_eq!((outcome.pc, outcome.sp), (0x2000, 0x5010));
    assert_eq!(context.cpl(), 3);
    assert_eq!(context.selector(Segment::Cs), 0x1b);
    assert_eq!(context.selector(Segment::Ss), 0x23);
    assert_eq!(context.selector(Segment::Ds), 0);
    assert!(!context.segment(Segment::Ds).usable);
}

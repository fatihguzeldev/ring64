use super::*;
use crate::x86::context::{TableRegister, TaskRegister};

fn fixture(mode: &str) -> (ExecutionContext, Image) {
    let mut context = tests::context(mode, 3);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 0x7f,
    });
    for (segment, selector) in [(Segment::Cs, 0x1b), (Segment::Ss, 0x23)] {
        let mut attributes = context.attributes(segment);
        attributes.dpl = 3;
        context.set_segment(segment, selector, context.segment(segment), attributes);
    }
    context.set_tr(TaskRegister {
        selector: 0x28,
        valid: true,
        base: 0x2000,
        limit: 0x67,
        attributes: 0x8b,
    });
    let mut image = tests::image();
    image
        .write(
            0x1008,
            8,
            if mode == "protected" {
                0x00cf_9b00_0000_ffff
            } else {
                0x00af_9b00_0000_ffff
            },
        )
        .unwrap();
    image.write(0x1010, 8, 0x00cf_9300_0000_ffff).unwrap();
    image
        .write(
            0x1018,
            8,
            if mode == "long64" {
                0x00af_fb00_0000_ffff
            } else {
                0x00cf_fb00_0000_ffff
            },
        )
        .unwrap();
    image.write(0x1020, 8, 0x00cf_f300_0000_ffff).unwrap();
    (context, image)
}

fn call(
    context: &mut ExecutionContext,
    image: &mut Image,
    source_width: Width,
    sp: u64,
) -> Result<FarOutcome, FarFailure> {
    let memory = context.is_long64();
    if memory {
        let mut bytes = vec![0xff; source_width.bytes() as usize];
        bytes.extend_from_slice(&0x3bu16.to_le_bytes());
        image.write_bytes(0x1100, &bytes).unwrap();
    }
    execute(
        context,
        image,
        FarDescriptor {
            kind: FarKind::Call,
            width: source_width,
            memory,
        },
        FarOperands {
            offset: if memory { 0x1100 } else { 0xffff },
            selector: 0x3b,
            input_sp: sp,
            next_pc: 0x1007,
            segment: Segment::Ds,
        },
    )
}

#[test]
fn gate32_inner_call_copies_literal_parameters_and_returns_with_both_cleanups() {
    let (mut context, mut image) = fixture("protected");
    image
        .write_bytes(0x1038, &[0x00, 0x20, 0x08, 0x00, 0x03, 0xec, 0x00, 0x00])
        .unwrap();
    image.write(0x2008, 2, 0x10).unwrap();
    image.write(0x2004, 4, 0x9000).unwrap();
    for (address, value) in [(0x4000, 0xa1), (0x4004, 0xb2), (0x4008, 0xc3)] {
        image.write(address, 4, value).unwrap();
    }
    let outcome = call(&mut context, &mut image, Width::W16, 0x4000).unwrap();
    assert_eq!((outcome.pc, outcome.sp), (0x2000, 0x8fe4));
    assert_eq!(
        (
            context.cpl(),
            context.selector(Segment::Cs),
            context.selector(Segment::Ss)
        ),
        (0, 8, 0x10)
    );
    let expected = [0x1007, 0x1b, 0xa1, 0xb2, 0xc3, 0x4000, 0x23];
    for (index, value) in expected.into_iter().enumerate() {
        assert_eq!(image.read(0x8fe4 + index as u64 * 4, 4).unwrap(), value);
    }
    let returned = tests::run(
        &mut context,
        &mut image,
        FarKind::Return,
        Width::W32,
        (12, 0),
        outcome.sp,
    )
    .unwrap();
    assert_eq!(
        (returned.pc, returned.sp, context.cpl()),
        (0x1007, 0x400c, 3)
    );
    assert_eq!(
        image.read(0x103d, 1).unwrap(),
        0xec,
        "gate type is not accessed code"
    );
}

#[test]
fn gate64_inner_call_uses_four_unaligned_qwords_ignoring_source_width_and_count() {
    let (mut context, mut image) = fixture("long64");
    image
        .write_bytes(
            0x1038,
            &[
                0x30, 0x20, 0x08, 0x00, 0xff, 0xec, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
        )
        .unwrap();
    image.write(0x2004, 8, 0x9003).unwrap();
    let outcome = call(&mut context, &mut image, Width::W16, 0x4000).unwrap();
    assert_eq!((outcome.pc, outcome.sp), (0x2030, 0x8fe3));
    assert_eq!((context.cpl(), context.selector(Segment::Ss)), (0, 0));
    assert!(!context.segment(Segment::Ss).usable);
    for (index, value) in [0x1007, 0x1b, 0x4000, 0x23].into_iter().enumerate() {
        assert_eq!(image.read(0x8fe3 + index as u64 * 8, 8).unwrap(), value);
    }
}

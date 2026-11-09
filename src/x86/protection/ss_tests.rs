use super::tests::{context, image, mapping, run};
use super::*;

#[test]
fn mov_ss_captures_aliased_selector_before_accessed_write_and_denial_is_atomic() {
    for writable in [false, true] {
        let mut context = context("protected", 2);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 0xd7,
        });
        // Access byte D2 is also the low byte of the selector D2; setting A changes its RPL.
        let mut image = image(
            vec![0xff, 0xff, 0x00, 0x20, 0x00, 0xd2, 0x40, 0x00],
            vec![
                mapping(0x10d0, 0, 8, true, writable),
                mapping(0x2000, 5, 1, true, true),
                mapping(0x2001, 7, 1, true, true),
            ],
        );
        let before = context.clone();
        let descriptor = ProtectionDescriptor {
            kind: ProtectionKind::LoadSegment(Segment::Ss),
            width: Width::W16,
            memory: true,
        };
        assert_eq!(
            ProtectionDescriptor::try_decode(descriptor.encode()),
            Some(descriptor)
        );
        assert!(valid_in_mode(descriptor, &context));
        let result = run(
            &mut context,
            &mut image,
            descriptor.kind,
            descriptor.width,
            true,
            0x2000,
            0,
        );
        if writable {
            assert!(result.unwrap().context_changed);
            assert_eq!(context.selector(Segment::Ss), 0xd2);
            assert_eq!(context.segment(Segment::Ss).base, 0x2000);
            assert_eq!(context.segment(Segment::Ss).limit, 0xffff);
            assert!(context.segment(Segment::Ss).default32);
            assert_eq!(image.read(0x2000, 2).unwrap(), 0xd3);
        } else {
            assert!(matches!(
                result,
                Err(Failure::SystemMemory(SystemMemoryFault {
                    phase: SystemPhase::AccessedWrite,
                    address: 0x10d5,
                    width: 1,
                    ..
                }))
            ));
            assert_eq!(context, before);
            assert_eq!(image.read(0x2000, 2).unwrap(), 0xd2);
        }
    }
}

#[test]
fn mov_ss_exact_word_source_at_last_u64_byte_uses_long_null_rules() {
    let mut context = context("long64", 0);
    let mut image = image(vec![0, 0], vec![mapping(u64::MAX - 1, 0, 2, true, false)]);
    run(
        &mut context,
        &mut image,
        ProtectionKind::LoadSegment(Segment::Ss),
        Width::W16,
        true,
        u64::MAX - 1,
        0,
    )
    .unwrap();
    assert_eq!(context.selector(Segment::Ss), 0);
    assert!(!context.segment(Segment::Ss).usable);
    assert_eq!(context.segment(Segment::Ss).base, 0);

    let mut context = super::tests::context("long64", 3);
    let before = context.clone();
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadSegment(Segment::Ss),
            Width::W16,
            true,
            u64::MAX - 1,
            0
        ),
        Err(Failure::Protection(ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: ProtectionPhase::Selector,
            selector: Some(0)
        }))
    );
    assert_eq!(context, before);
}

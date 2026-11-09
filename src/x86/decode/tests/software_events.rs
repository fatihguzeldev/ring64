use super::*;
use crate::x86::instruction::{SoftwareEventDescriptor, SoftwareEventKind as Kind};

#[test]
fn software_event_forms_are_distinct_and_iret_long_default_is_32() {
    for (bytes, kind, width, vector) in [
        (&[0xcc][..], Kind::Int3, Width::W16, 3),
        (&[0xcd, 3], Kind::Interrupt, Width::W16, 3),
        (&[0xf3, 0xf2, 0xcd, 3], Kind::Interrupt, Width::W16, 3),
        (&[0xcd, 0xff], Kind::Interrupt, Width::W16, 0xff),
        (&[0xf1], Kind::Int1, Width::W16, 1),
        (&[0xcf], Kind::Return, Width::W32, 0),
        (&[0x66, 0xcf], Kind::Return, Width::W16, 0),
        (&[0x66, 0x48, 0xcf], Kind::Return, Width::W64, 0),
        (&[0x48, 0x66, 0xcf], Kind::Return, Width::W16, 0),
        (&[0xf3, 0x67, 0x48, 0xcd, 7], Kind::Interrupt, Width::W16, 7),
    ] {
        assert_eq!(
            operation(bytes),
            Operation::SoftwareEvent(SoftwareEventDescriptor {
                kind,
                width,
                vector
            })
        );
    }
    assert_eq!(at(0x1000, &[0xce]), Err(DecodeError::Invalid));
}

#[test]
fn event_required_immediate_and_lock_frontiers_are_precise() {
    for prefix in [&[][..], &[0xf0], &[0xf3, 0x66]] {
        let mut bytes = prefix.to_vec();
        bytes.push(0xcd);
        assert!(matches!(at(0x1000, &bytes), Err(DecodeError::Fetch(_))));
    }
    for bytes in [
        &[0xf0, 0xcc][..],
        &[0xf0, 0xcd, 3],
        &[0xf0, 0xcf],
        &[0xf0, 0xf1],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Invalid));
    }
    assert_eq!(
        at(0x1000, &[0xf0, 0xf3, 0xcd, 3]),
        Err(DecodeError::Unsupported)
    );
}

#[test]
fn event_widths_follow_fourteen_source_profiles_without_using_stack_address_width() {
    use crate::x86::context::{ExecutionContext, Mode, Segment};
    let mut profiles = 0;
    for mode in [
        Mode::Real,
        Mode::Protected,
        Mode::Compatibility,
        Mode::Virtual8086,
        Mode::Long64,
    ] {
        for code32 in [false, true] {
            for stack32 in [false, true] {
                if matches!(mode, Mode::Virtual8086 | Mode::Long64) && (code32 || stack32) {
                    continue;
                }
                profiles += 1;
                let mut context = ExecutionContext::default();
                context.set_mode_and_cpl(mode, if mode == Mode::Virtual8086 { 3 } else { 0 });
                if mode == Mode::Virtual8086 {
                    for segment in Segment::ALL {
                        let selector = context.selector(segment);
                        context.set_segment(
                            segment,
                            selector,
                            crate::x86::context::LoadedSegment {
                                base: u64::from(selector) << 4,
                                limit: 0xffff,
                                default32: false,
                                usable: true,
                                kind: crate::x86::context::SegmentType::ReadWrite,
                            },
                            crate::x86::context::SegmentAttributes {
                                dpl: 3,
                                present: true,
                                accessed: true,
                                ..crate::x86::context::SegmentAttributes::default()
                            },
                        );
                    }
                }
                for (segment, default32) in [(Segment::Cs, code32), (Segment::Ss, stack32)] {
                    let mut cache = context.segment(segment);
                    cache.default32 = default32;
                    let mut attributes = context.attributes(segment);
                    attributes.long = segment == Segment::Cs && mode == Mode::Long64;
                    context.set_segment(segment, context.selector(segment), cache, attributes);
                }
                for (bytes, kind, vector, overridden) in [
                    (&[0xcf][..], Kind::Return, 0, false),
                    (&[0x66, 0xcf], Kind::Return, 0, true),
                    (&[0xcc], Kind::Int3, 3, false),
                    (&[0xcd, 3], Kind::Interrupt, 3, false),
                    (&[0xf1], Kind::Int1, 1, false),
                    (&[0xce], Kind::Into, 4, false),
                ] {
                    let result = super::super::decode_with_context(0x1000, &context, |pc| {
                        bytes
                            .get((pc - 0x1000) as usize)
                            .copied()
                            .ok_or(DecodeError::Fetch(missing(pc)))
                    });
                    if mode == Mode::Long64 && kind == Kind::Into {
                        assert_eq!(result, Err(DecodeError::Invalid));
                        continue;
                    }
                    let instruction = result.unwrap();
                    let width = if kind == Kind::Return
                        && (if mode == Mode::Long64 { true } else { code32 }) != overridden
                    {
                        Width::W32
                    } else {
                        Width::W16
                    };
                    assert_eq!(
                        instruction.operation,
                        Operation::SoftwareEvent(SoftwareEventDescriptor {
                            kind,
                            width,
                            vector
                        }),
                        "{mode:?} CS32={code32} SS32={stack32}"
                    );
                    assert_eq!(instruction.encoded_len(), bytes.len() as u32);
                }
            }
        }
    }
    assert_eq!(profiles, 14);
}

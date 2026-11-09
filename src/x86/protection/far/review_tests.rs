use super::tests::{context, image, run};
use super::*;
use crate::memory::{Cause, MappingInput, MemoryLimits, Permissions};
use crate::x86::context::{SegmentCause, SegmentFault, TableRegister};
use crate::x86::protection::{SystemMemoryFault, SystemPhase, Table};

fn mapping(base: u64, offset: u32, length: u32, read: bool, write: bool) -> MappingInput {
    MappingInput {
        base,
        backing: "ram".into(),
        offset,
        length,
        permissions: Permissions {
            read,
            write,
            execute: true,
        },
    }
}

fn mapped(bytes: Vec<u8>, mappings: Vec<MappingInput>) -> Image {
    Image::mapped(
        vec![("ram".into(), bytes)],
        mappings,
        MemoryLimits {
            max_backing_bytes: 128,
            max_backings: 1,
            max_mappings: 16,
        },
    )
    .unwrap()
}

#[test]
fn outer_return_captures_both_aliasing_descriptors_before_any_accessed_write() {
    for allow_stack_accessed in [false, true] {
        let mut context = context("long64", 0);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 0x17,
        });
        let original_context = context.clone();
        let mut bytes = vec![0; 64];
        // CS.base low byte aliases SS.access; SS.base low byte aliases CS.access.
        bytes[..8].copy_from_slice(&[0xff, 0xff, 0xf2, 0, 0, 0xfa, 0xaf, 0]);
        bytes[16..18].copy_from_slice(&[0xff, 0xff]);
        bytes[22..24].copy_from_slice(&[0xcf, 0]);
        for (index, value) in [0x2000u64, 0x0b, 0x5000, 0x13].into_iter().enumerate() {
            bytes[32 + index * 8..40 + index * 8].copy_from_slice(&value.to_le_bytes());
        }
        let mut image = mapped(
            bytes,
            vec![
                mapping(0x1008, 0, 8, true, true),
                mapping(0x1010, 16, 2, true, false),
                mapping(0x1012, 5, 1, true, true),
                mapping(0x1013, 19, 2, true, false),
                mapping(0x1015, 2, 1, true, allow_stack_accessed),
                mapping(0x1016, 22, 2, true, false),
                mapping(0x4000, 32, 32, true, false),
            ],
        );
        let original_code = image.read_bytes(0x1008, 8).unwrap();
        let original_stack = image.read_bytes(0x1010, 8).unwrap();
        let original_frame = image.read_bytes(0x4000, 32).unwrap();
        let owner = image.register_source([(0x1008, 8)]).unwrap();
        assert!(image.activate(owner));
        let result = run(
            &mut context,
            &mut image,
            FarKind::Return,
            Width::W64,
            (0, 0),
            0x4000,
        );
        if allow_stack_accessed {
            let outcome = result.unwrap();
            assert_eq!((outcome.pc, outcome.sp), (0x2000, 0x5000));
            assert_eq!((context.cpl(), context.mode()), (3, Mode::Long64));
            assert_eq!(context.segment(Segment::Cs).base, 0xf2);
            assert_eq!(context.segment(Segment::Ss).base, 0xfa);
            assert!(context.attributes(Segment::Cs).accessed);
            assert!(context.attributes(Segment::Ss).accessed);
            assert_eq!(image.read(0x100a, 1).unwrap(), 0xf3);
            assert_eq!(image.read(0x100d, 1).unwrap(), 0xfb);
            assert_eq!(image.read(0x1012, 1).unwrap(), 0xfb);
            assert_eq!(image.read(0x1015, 1).unwrap(), 0xf3);
            assert!(!image.owner_valid(owner));
            assert!(image.active_changed());
            assert_eq!(
                ExecutionContext::from_json(&context.to_json()).unwrap(),
                context
            );
        } else {
            assert_eq!(
                result,
                Err(FarFailure::SystemMemory(SystemMemoryFault {
                    address: 0x1015,
                    width: 1,
                    access: Access::Write,
                    cause: Cause::Permission,
                    failing_address: 0x1015,
                    phase: SystemPhase::AccessedWrite,
                    table: Table::Gdt,
                    selector: 0x13,
                }))
            );
            assert_eq!(context, original_context);
            assert_eq!(image.read_bytes(0x1008, 8).unwrap(), original_code);
            assert_eq!(image.read_bytes(0x1010, 8).unwrap(), original_stack);
            assert!(image.owner_valid(owner));
            assert!(!image.active_changed());
        }
        assert_eq!(image.read_bytes(0x4000, 32).unwrap(), original_frame);
    }
}

#[test]
fn return_reads_the_whole_selector_slot_but_uses_only_its_low_sixteen_bits() {
    for read_padding in [false, true] {
        let mut context = context("long64", 0);
        let original_context = context.clone();
        let mut bytes = vec![0; 32];
        bytes[..8].copy_from_slice(&0x00af_9800_0000_ffffu64.to_le_bytes());
        bytes[16..20].copy_from_slice(&0x2000u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&0xdead_0008u32.to_le_bytes());
        let mut image = mapped(
            bytes,
            vec![
                mapping(0x1008, 0, 8, true, true),
                mapping(0x4000, 16, 6, true, false),
                mapping(0x4006, 22, 2, read_padding, false),
                mapping(0x5000, 16, 8, true, false),
            ],
        );
        let original_frame = image.read_bytes(0x5000, 8).unwrap();
        let owner = image.register_source([(0x1008, 8)]).unwrap();
        assert!(image.activate(owner));
        let result = run(
            &mut context,
            &mut image,
            FarKind::Return,
            Width::W32,
            (0, 0),
            0x4000,
        );
        if read_padding {
            let outcome = result.unwrap();
            assert_eq!((outcome.pc, outcome.sp), (0x2000, 0x4008));
            assert_eq!(context.selector(Segment::Cs), 8);
            assert_eq!(context.segment(Segment::Cs).kind, SegmentType::Code);
            assert_eq!(image.read(0x100d, 1).unwrap(), 0x99);
            assert!(!image.owner_valid(owner));
        } else {
            assert!(matches!(
                result,
                Err(FarFailure::Operand {
                    segment: Segment::Ss,
                    failure: AccessFailure::Linear(crate::memory::Fault {
                        address: 0x4004,
                        width: 4,
                        access: Access::Read,
                        cause: Cause::Permission,
                        failing: 0x4006,
                    }),
                })
            ));
            assert_eq!(context, original_context);
            assert_eq!(image.read(0x100d, 1).unwrap(), 0x98);
            assert!(image.owner_valid(owner));
            assert!(!image.active_changed());
        }
        assert_eq!(image.read_bytes(0x5000, 8).unwrap(), original_frame);
    }
}

#[test]
fn cs_only_mode_handoffs_preserve_hidden_unusable_stack_and_raw_data_bases() {
    let mut context = context("long64", 0);
    let mut image = image();
    let mut ss = context.segment(Segment::Ss);
    ss.base = 0x7fff_1234_0000;
    ss.limit = 0;
    ss.usable = false;
    ss.kind = SegmentType::ReadOnly;
    let ss_attributes = context.attributes(Segment::Ss);
    context.set_segment(Segment::Ss, 0, ss, ss_attributes);
    for (segment, base) in [
        (Segment::Ds, 0x1122_3344_5566_7788),
        (Segment::Fs, 0xffff_8000_0000_1234),
    ] {
        let mut cache = context.segment(segment);
        cache.base = base;
        context.set_segment(
            segment,
            context.selector(segment),
            cache,
            context.attributes(segment),
        );
    }
    let ds = context.segment(Segment::Ds);
    let fs = context.segment(Segment::Fs);
    image.write(0x1008, 8, 0x004f_9b00_2000_ffff).unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Jump,
        Width::W32,
        (0x2000, 8),
        u64::MAX,
    )
    .unwrap();
    assert_eq!((outcome.pc, outcome.sp), (0x2000, u64::MAX));
    assert_eq!(context.mode(), Mode::Compatibility);
    assert_eq!(context.segment(Segment::Ss), ss);
    assert_eq!(context.attributes(Segment::Ss), ss_attributes);
    assert_eq!(context.segment(Segment::Ds), ds);
    assert_eq!(context.segment(Segment::Fs), fs);
    assert_eq!(
        ExecutionContext::from_json(&context.to_json()).unwrap(),
        context
    );
    assert!(matches!(
        context.translate(0, 4, Segment::Ss, Access::Write, false),
        Err(AccessFailure::Segment(SegmentFault {
            cause: SegmentCause::Unusable,
            ..
        }))
    ));
    assert_eq!(
        context.translate(1, 1, Segment::Ds, Access::Read, false),
        Ok(0x5566_7789)
    );
    assert_eq!(
        context.translate(0x10, 1, Segment::Fs, Access::Read, false),
        Ok(0x1244)
    );

    image.write(0x1008, 8, 0x00af_9b00_0000_ffff).unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Jump,
        Width::W32,
        (0x2000, 8),
        u64::MAX,
    )
    .unwrap();
    assert_eq!(outcome.sp, u64::MAX);
    assert_eq!(context.mode(), Mode::Long64);
    assert_eq!(context.segment(Segment::Ss), ss);
    assert_eq!(context.segment(Segment::Ds), ds);
    assert_eq!(context.segment(Segment::Fs), fs);
    assert_eq!(
        context.translate(0x10, 1, Segment::Fs, Access::Read, false),
        Ok(0xffff_8000_0000_1244)
    );
    assert_eq!(
        ExecutionContext::from_json(&context.to_json()).unwrap(),
        context
    );
}

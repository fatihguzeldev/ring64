use super::gate_review_tests::{expected_fault, gate};
use super::gate_tests::{call, fixture};
use super::*;
use crate::memory::{Cause, MappingInput, Permissions};
use crate::x86::context::{LdtRegister, TableRegister};
use crate::x86::protection::{SystemMemoryFault, SystemPhase, SystemReference, Table};

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

fn gate64(image: &mut Image) {
    image
        .write_bytes(
            0x1038,
            &[0x30, 0x20, 8, 0, 0xff, 0xec, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        )
        .unwrap();
}

#[test]
fn observations_use_captured_linear_addresses_across_both_stack_contexts_and_retf() {
    let (mut context, mut image) = fixture("protected");
    gate(&mut image, Width::W32, 2, 8);
    image
        .write_bytes(0x1010, &[0xff, 0xff, 0, 0x20, 0, 0x93, 0xcf, 0])
        .unwrap(); // New SS.base=2000.
    let mut ss = context.segment(Segment::Ss);
    ss.base = 0x1000;
    context.set_segment(Segment::Ss, 0x23, ss, context.attributes(Segment::Ss));
    let mut ds = context.segment(Segment::Ds);
    ds.base = 0x300;
    context.set_segment(
        Segment::Ds,
        context.selector(Segment::Ds),
        ds,
        context.attributes(Segment::Ds),
    );
    image.write_bytes(0x1400, &[0xff, 0xff, 0x3b, 0]).unwrap();
    image.write(0x2008, 2, 0x10).unwrap();
    image.write(0x2004, 4, 0x9000).unwrap();
    image.write(0x5000, 4, 0x1122_3344).unwrap();
    image.write(0x5004, 4, 0x5566_7788).unwrap();
    let mut observed = Vec::new();
    let outcome = execute_observing(
        &mut context,
        &mut image,
        FarDescriptor {
            kind: FarKind::Call,
            width: Width::W16,
            memory: true,
        },
        FarOperands {
            offset: 0x1100,
            selector: 0,
            input_sp: 0x4000,
            next_pc: 0x1007,
            segment: Segment::Ds,
        },
        |address, width, access| observed.push((address, width, access)),
    )
    .unwrap();
    assert_eq!(
        (outcome.sp, context.segment(Segment::Ss).base),
        (0x8fe8, 0x2000)
    );
    assert_eq!(
        observed,
        vec![
            (0x1400, 4, Access::Read),
            (0x5000, 4, Access::Read),
            (0x5004, 4, Access::Read),
            (0xaffc, 4, Access::Write),
            (0xaff8, 4, Access::Write),
            (0xaff4, 4, Access::Write),
            (0xaff0, 4, Access::Write),
            (0xafec, 4, Access::Write),
            (0xafe8, 4, Access::Write),
        ]
    );
    observed.clear();
    let returned = execute_observing(
        &mut context,
        &mut image,
        FarDescriptor {
            kind: FarKind::Return,
            width: Width::W32,
            memory: false,
        },
        FarOperands {
            offset: 8,
            selector: 0,
            input_sp: outcome.sp,
            next_pc: 0,
            segment: Segment::Ss,
        },
        |address, width, access| observed.push((address, width, access)),
    )
    .unwrap();
    assert_eq!(
        (returned.sp, returned.pc, context.cpl()),
        (0x4008, 0x1007, 3)
    );
    assert_eq!(
        observed,
        vec![
            (0xafe8, 4, Access::Read),
            (0xafec, 4, Access::Read),
            (0xaff8, 4, Access::Read),
            (0xaffc, 4, Access::Read)
        ]
    );
}

#[test]
fn gate64_checks_only_touched_spans_and_preserves_same_cpl_ss() {
    const HOLE: u64 = 0x8000_0000_0000;
    for inner in [false, true] {
        let (mut context, mut image) = fixture("long64");
        gate64(&mut image);
        if !inner {
            image.write(0x100d, 1, 0xfb).unwrap();
        }
        image.write(0x2004, 8, HOLE).unwrap();
        image
            .set_mappings(vec![
                mapping(0, 0, 0x11000, true, true),
                mapping(HOLE - 0x1000, 0xf000, 0x1000, true, true),
            ])
            .unwrap();
        let ss = (
            context.selector(Segment::Ss),
            context.segment(Segment::Ss),
            context.attributes(Segment::Ss),
        );
        let outcome = call(&mut context, &mut image, Width::W16, HOLE).unwrap();
        assert_eq!(outcome.sp, HOLE - if inner { 32 } else { 16 });
        assert_eq!(image.read(outcome.sp, 8).unwrap(), 0x1007);
        assert_eq!(image.read(outcome.sp + 8, 8).unwrap(), 0x1b);
        if inner {
            assert_eq!(
                (
                    context.selector(Segment::Ss),
                    context.attributes(Segment::Ss).dpl
                ),
                (0, 0)
            );
            assert_eq!(image.read(outcome.sp + 16, 8).unwrap(), HOLE);
        } else {
            assert_eq!(
                (
                    context.selector(Segment::Ss),
                    context.segment(Segment::Ss),
                    context.attributes(Segment::Ss)
                ),
                ss
            );
        }
    }
    for sp in [0xffff_8000_0000_0000, 3] {
        let (mut context, mut image) = fixture("long64");
        gate64(&mut image);
        image.write(0x100d, 1, 0xfb).unwrap();
        let original = context.clone();
        let result = call(&mut context, &mut image, Width::W16, sp);
        if sp == 3 {
            assert!(
                matches!(result, Err(FarFailure::Operand { failure: AccessFailure::Linear(crate::memory::Fault { cause: Cause::AddressRange, failing, .. }), .. }) if failing == 1u128 << 64)
            );
        } else {
            assert_eq!(
                result,
                Err(FarFailure::Protection(ProtectionFault {
                    vector: 12,
                    error_code: 0,
                    phase: ProtectionPhase::Target,
                    selector: None
                }))
            );
        }
        assert_eq!(context, original);
    }
}

#[test]
fn compatibility_same_cpl_gate64_uses_full_raw_rsp_and_prospective_long_stack() {
    let (mut context, mut image) = fixture("compatibility");
    gate64(&mut image);
    image.write(0x100d, 1, 0xfb).unwrap();
    let mut ss = context.segment(Segment::Ss);
    ss.usable = false;
    ss.base = 0x1234_0000;
    ss.default32 = false;
    ss.limit = 0;
    context.set_segment(Segment::Ss, 0x23, ss, context.attributes(Segment::Ss));
    let attributes = context.attributes(Segment::Ss);
    image
        .set_mappings(vec![
            mapping(0, 0, 0x11000, true, true),
            mapping(0xffff_8000_0000_8000, 0x8000, 0x2000, true, true),
        ])
        .unwrap();
    let outcome = call(&mut context, &mut image, Width::W16, 0xffff_8000_0000_9003).unwrap();
    assert_eq!(
        (outcome.pc, outcome.sp, context.mode()),
        (0x2030, 0xffff_8000_0000_8ff3, Mode::Long64)
    );
    assert_eq!(
        (
            context.segment(Segment::Ss),
            context.attributes(Segment::Ss)
        ),
        (ss, attributes)
    );
    assert_eq!(image.read(outcome.sp, 8).unwrap(), 0x1007);
}

#[test]
fn selected_gate_extent_precedes_presence_and_presence_precedes_tail_access() {
    for access in [0x0c, 0x6c, 0xec] {
        let (mut context, mut image) = fixture("long64");
        gate64(&mut image);
        image.write(0x103d, 1, access).unwrap();
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 0x3f,
        });
        expected_fault(
            call(&mut context, &mut image, Width::W16, 0x4000),
            13,
            0x3b,
            ProtectionPhase::Selector,
        );
    }
    for access in [0x0c, 0x6c, 0xec] {
        let (mut context, mut image) = fixture("long64");
        gate64(&mut image);
        image.write(0x103d, 1, access).unwrap();
        image
            .set_mappings(vec![
                mapping(0x1038, 0x1038, 8, true, false),
                mapping(0x1100, 0x1100, 10, true, true),
            ])
            .unwrap();
        let result = call(&mut context, &mut image, Width::W16, 0x4000);
        if access == 0xec {
            assert!(matches!(
                result,
                Err(FarFailure::SystemMemory(SystemMemoryFault {
                    address: 0x1040,
                    phase: SystemPhase::DescriptorRead,
                    reference: SystemReference::Selector(0x3b),
                    cause: Cause::Unmapped,
                    ..
                }))
            ));
        } else {
            expected_fault(
                result,
                if access == 0x0c { 13 } else { 11 },
                0x3b,
                ProtectionPhase::Descriptor,
            );
        }
    }
}

#[test]
fn expanded_ldt_tail_does_not_wrap_its_original_index_or_selector() {
    for ldt in [false, true] {
        let (mut context, mut image) = fixture("compatibility");
        gate64(&mut image);
        image.write(0x100d, 1, 0xfb).unwrap();
        image
            .set_mappings(vec![
                mapping(0, 0, 0xf000, true, true),
                mapping(0xfff8, 0x1038, 16, true, false),
            ])
            .unwrap();
        if ldt {
            context.set_ldtr(LdtRegister {
                selector: 0x30,
                valid: true,
                base: 0,
                limit: 0x10007,
                attributes: 0x82,
            });
        } else {
            context.set_gdtr(TableRegister {
                base: 0,
                limit: 0xffff,
            });
        }
        let selector = if ldt { 0xffff } else { 0xfffb };
        let result = execute(
            &mut context,
            &mut image,
            FarDescriptor {
                kind: FarKind::Call,
                width: Width::W16,
                memory: false,
            },
            FarOperands {
                offset: 0xffff,
                selector,
                input_sp: 0x9000,
                next_pc: 0x1007,
                segment: Segment::Ds,
            },
        );
        if ldt {
            let outcome = result.unwrap();
            assert_eq!((outcome.pc, outcome.sp), (0x2030, 0x8ff0));
        } else {
            expected_fault(result, 13, selector, ProtectionPhase::Selector);
        }
    }
}

#[test]
fn noncanonical_gate_tail_keeps_original_system_provenance_after_low_admission() {
    let base = 0x7fff_ffff_ffc0;
    for access in [0x0c, 0x6c, 0xec] {
        let (mut context, mut image) = fixture("long64");
        gate64(&mut image);
        image.write(0x103d, 1, access).unwrap();
        context.set_gdtr(TableRegister { base, limit: 0x7f });
        image
            .set_mappings(vec![
                mapping(base + 0x38, 0x1038, 8, true, false),
                mapping(0x1100, 0x1100, 10, true, true),
            ])
            .unwrap();
        let result = call(&mut context, &mut image, Width::W16, 0x4000);
        if access == 0xec {
            assert_eq!(
                result,
                Err(FarFailure::SystemMemory(SystemMemoryFault {
                    address: 0x8000_0000_0000,
                    width: 8,
                    access: Access::Read,
                    cause: Cause::Noncanonical,
                    failing_address: 0x8000_0000_0000,
                    phase: SystemPhase::DescriptorRead,
                    table: Table::Gdt,
                    reference: SystemReference::Selector(0x3b),
                }))
            );
        } else {
            expected_fault(
                result,
                if access == 0x0c { 13 } else { 11 },
                0x3b,
                ProtectionPhase::Descriptor,
            );
        }
    }
}

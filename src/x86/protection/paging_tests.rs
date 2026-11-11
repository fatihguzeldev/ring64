use super::*;
use crate::memory::{MappingInput, MemoryLimits, Permissions};
use crate::x86::paging::{
    State,
    access::{AccessState, Memory},
    walk,
};

fn put(bytes: &mut [u8], offset: usize, word: u64) {
    bytes[offset..offset + 8].copy_from_slice(&word.to_le_bytes());
}

fn setup(deny_dirty: bool, gdt_leaf: u64, descriptor: u64) -> (ExecutionContext, Image, State) {
    let mut bytes = vec![0xa5; 0xd000];
    bytes[..0x4000].fill(0);
    for (offset, word) in [
        (0, 0x2027),
        (0x1000, 0x3027),
        (0x2000, 0x4027),
        (0x3020, gdt_leaf),
        (0x3028, 0xc023),
        (0x3038, 0xb023),
        (0x3040, 0xa023),
    ] {
        put(&mut bytes, offset, word);
    }
    put(&mut bytes, 0x8008, 0x00af9b000000ffff);
    put(&mut bytes, 0x8010, descriptor);
    put(&mut bytes, 0xb060, 0x00008e0000081000);
    put(&mut bytes, 0xb068, 0);
    let mapping = |base, offset, length, write| MappingInput {
        base,
        offset,
        length,
        backing: "data".into(),
        permissions: Permissions {
            read: true,
            write,
            execute: true,
        },
    };
    let mappings = if deny_dirty {
        vec![
            mapping(0x1000, 0, 0x3038, true),
            mapping(0x4038, 0x3038, 8, false),
            mapping(0x4040, 0x3040, 0x9fc0, true),
        ]
    } else {
        vec![mapping(0x1000, 0, 0xd000, true)]
    };
    let image = Image::physical_mapped(
        vec![("data".into(), bytes)],
        mappings,
        MemoryLimits {
            max_backing_bytes: 0xd000,
            max_backings: 1,
            max_mappings: 8,
        },
    )
    .unwrap();
    let mut context = tests::context("long64", 0);
    context.set_gdtr(TableRegister {
        base: 0x4000,
        limit: 0x3f,
    });
    context.set_idtr(TableRegister {
        base: 0x5000,
        limit: 0xfff,
    });
    let state = State {
        cr0: 0x80010033,
        cr3: 0x1000,
        ..State::default()
    };
    (context, image, state)
}

#[test]
fn ring3_descriptor_traffic_uses_supervisor_permissions_and_provenance() {
    let (mut context, mut image, state) = setup(false, 0x9023, 0x00cff3000000ffff);
    context.set_mode_and_cpl(Mode::Long64, 3);
    let mut work = AccessState::default();
    let mut memory = Memory::new(&mut image, &state, 3, &mut work);
    let outcome = execute(
        &mut context,
        &mut memory,
        ProtectionDescriptor {
            kind: ProtectionKind::LoadSegment(Segment::Fs),
            width: Width::W16,
            memory: false,
        },
        0,
        0x13,
        Segment::Ds,
    )
    .unwrap();
    assert!(outcome.context_changed);
    assert_eq!(context.selector(Segment::Fs), 0x13);
    let (mut context, mut image, state) = setup(false, 0x9021, 0x00cff2000000ffff);
    context.set_mode_and_cpl(Mode::Long64, 3);
    let mut work = AccessState::default();
    let mut memory = Memory::new(&mut image, &state, 3, &mut work);
    assert_eq!(
        execute(
            &mut context,
            &mut memory,
            ProtectionDescriptor {
                kind: ProtectionKind::LoadSegment(Segment::Fs),
                width: Width::W16,
                memory: false
            },
            0,
            0x13,
            Segment::Ds
        ),
        Err(Failure::SystemPaging(SystemPagingFault {
            failure: walk::Failure::Page(walk::PageFault {
                address: 0x4015,
                access: Access::Write,
                error_code: 3
            }),
            phase: SystemPhase::AccessedWrite,
            table: Table::Gdt,
            reference: SystemReference::Selector(0x13)
        }))
    );
}

#[test]
fn frame_dirty_refusal_precedes_every_frame_payload_and_context_publication() {
    let (mut context, mut image, state) = setup(true, 0x9023, 0x00cff3000000ffff);
    let before = context.clone();
    let mut work = AccessState::default();
    let mut memory = Memory::new(&mut image, &state, 0, &mut work);
    let source = crate::x86::exception::ExceptionEvent {
        vector: 6,
        instruction_pc: 0x1000,
        return_pc: 0x1000,
        saved_flags: 0x10002,
        error_code: None,
        debug: None,
        page_fault_address: None,
    };
    let result = event::enter_exception(&mut context, &mut memory, source, 0x8010, 2);
    assert!(
        matches!(
            result,
            Err(event::EventFailure::Operand {
                segment: Segment::Ss,
                failure: AccessFailure::Paging(walk::Failure::Physical(walk::PhysicalFault {
                    phase: walk::PhysicalPhase::DirtyWrite,
                    ..
                }))
            })
        ),
        "{result:?}"
    );
    assert_eq!(context, before);
    assert_eq!(
        image.physical_read(0x4040, 8).unwrap(),
        0xa023,
        "no earlier D publication"
    );
    assert_eq!(
        image.physical_read_bytes(0xa000, 0x10).unwrap(),
        vec![0xa5; 0x10]
    );
    assert_eq!(
        image.physical_read_bytes(0xbfd0, 0x30).unwrap(),
        vec![0xa5; 0x30]
    );
}

#[test]
fn busy_descriptor_nominal_second_page_is_not_a_selected_dirty_payload() {
    let (mut context, mut image, state) = setup(false, 0x9023, 0);
    context.set_gdtr(TableRegister {
        base: 0x4ff0,
        limit: 0x17,
    });
    image.physical_write(0x9ff8, 8, 0x0000890060000067).unwrap();
    image.physical_write(0xc000, 8, 0).unwrap();
    let mapping = |base, offset, length, write| MappingInput {
        base,
        offset,
        length,
        backing: "data".into(),
        permissions: Permissions {
            read: true,
            write,
            execute: true,
        },
    };
    image
        .set_mappings(vec![
            mapping(0x1000, 0, 0x3028, true),
            mapping(0x4028, 0x3028, 8, false),
            mapping(0x4030, 0x3030, 0x9fd0, true),
        ])
        .unwrap();
    let mut work = AccessState::default();
    let mut memory = Memory::new(&mut image, &state, 0, &mut work);
    let result = execute(
        &mut context,
        &mut memory,
        ProtectionDescriptor {
            kind: ProtectionKind::LoadTask,
            width: Width::W16,
            memory: false,
        },
        0,
        8,
        Segment::Ds,
    )
    .unwrap();
    assert!(result.context_changed);
    assert_eq!(context.tr().base, 0x6000);
    assert_eq!(context.tr().attributes & 15, 11);
    assert_eq!(image.physical_read(0x9ff8, 8).unwrap(), 0x00008b0060000067);
    assert_eq!(
        image.physical_read(0xc000, 8).unwrap(),
        0,
        "nominal second page stays untouched"
    );
    assert_eq!(
        image.physical_read(0x4020, 8).unwrap(),
        0x9063,
        "participating page gets D"
    );
    assert_eq!(
        image.physical_read(0x4028, 8).unwrap(),
        0xc023,
        "unwritten page needs no private D permission"
    );
}

#[test]
fn event_frame_privilege_uses_prepared_target_not_source_cpl() {
    for inner in [true, false] {
        let (mut context, mut image, state) = setup(false, 0x9023, 0);
        context.set_mode_and_cpl(Mode::Long64, 3);
        if inner {
            context.set_tr(crate::x86::context::TaskRegister {
                selector: 0x28,
                valid: true,
                base: 0x6000,
                limit: 0x67,
                attributes: 0x8b,
            });
            image.physical_write(0x4030, 8, 0xd023).unwrap();
            image.physical_write(0xd004, 8, 0x8010).unwrap();
        } else {
            image.physical_write(0x9008, 8, 0x00affb000000ffff).unwrap();
        }
        let before = context.clone();
        let mut work = AccessState::default();
        let mut memory = Memory::new(&mut image, &state, 3, &mut work);
        let event = crate::x86::exception::ExceptionEvent {
            vector: 6,
            instruction_pc: 0x1000,
            return_pc: 0x1000,
            saved_flags: 0x10002,
            error_code: None,
            debug: None,
            page_fault_address: None,
        };
        let result = event::enter_exception(&mut context, &mut memory, event, 0x8010, 2);
        if inner {
            assert_eq!(result.unwrap().sp, 0x7fe8);
            assert_eq!(context.cpl(), 0);
        } else {
            assert_eq!(
                result,
                Err(event::EventFailure::Operand {
                    segment: Segment::Ss,
                    failure: AccessFailure::Paging(walk::Failure::Page(walk::PageFault {
                        address: 0x8008,
                        access: Access::Write,
                        error_code: 7
                    }))
                })
            );
            assert_eq!(context, before);
        }
    }
}

#[test]
fn frame_payload_alias_can_clear_a_captured_d1_pte_without_late_rewalk_or_repair() {
    let (mut context, mut image, state) = setup(true, 0x9023, 0);
    let mapping = |base, offset, length, write| MappingInput {
        base,
        offset,
        length,
        backing: "data".into(),
        permissions: Permissions {
            read: true,
            write,
            execute: true,
        },
    };
    image
        .set_mappings(vec![mapping(0x1000, 0, 0xd000, true)])
        .unwrap();
    image.physical_write(0x4038, 8, 0xb063).unwrap();
    image
        .set_mappings(vec![
            mapping(0x1000, 0, 0x3038, true),
            mapping(0x4038, 0x3038, 8, false),
            mapping(0x4040, 0x3040, 0x5fc0, true),
            mapping(0xa000, 0x9000, 8, true),
            mapping(0xa008, 0x3038, 8, true),
            mapping(0xa010, 0x9010, 0x3ff0, true),
        ])
        .unwrap();
    let mut work = AccessState::default();
    let mut memory = Memory::new(&mut image, &state, 0, &mut work);
    let event = crate::x86::exception::ExceptionEvent {
        vector: 6,
        instruction_pc: 0x1000,
        return_pc: 0x1000,
        saved_flags: 0x10002,
        error_code: None,
        debug: None,
        page_fault_address: None,
    };
    let result = event::enter_exception(&mut context, &mut memory, event, 0x8010, 2).unwrap();
    assert_eq!(result.sp, 0x7fe8);
    assert_eq!(
        image.physical_read(0x4038, 8).unwrap(),
        0x10,
        "earlier saved SS overwrites the PTE"
    );
    assert_eq!(
        image.physical_read(0xbff8, 8).unwrap(),
        0x10002,
        "later slot still uses admitted PA"
    );
    assert_eq!(image.physical_read(0xbfe8, 8).unwrap(), 0x1000);
    let memory = Memory::new(&mut image, &state, 0, &mut work);
    assert_eq!(
        memory.read(0x7ff8, 8),
        Err(AccessFailure::Paging(walk::Failure::Page(
            walk::PageFault {
                address: 0x7ff8,
                access: Access::Read,
                error_code: 0
            }
        ))),
        "independent admission observes the new PTE"
    );
}

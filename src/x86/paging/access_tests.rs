use super::*;
use crate::memory::{MappingInput, MemoryLimits, Permissions};
use crate::x86::paging::walk::{Failure, PageFault, PhysicalPhase};

fn fixture(second: u64, data_write: bool, protected_pte: bool) -> (Image, State) {
    let mut bytes = vec![0; 0xc000];
    for (address, word) in [
        (0x1000, 0x2027u64),
        (0x2000, 0x3027),
        (0x3000, 0x4027),
        (0x4008, 0x9027),
        (0x4010, second),
        (0x4038, 0x7027),
        (0x4040, 0x8027),
    ] {
        bytes[address..address + 8].copy_from_slice(&word.to_le_bytes());
    }
    let mapping = |base, offset, length, write| MappingInput {
        base,
        backing: "ram".into(),
        offset,
        length,
        permissions: Permissions {
            read: true,
            write,
            execute: true,
        },
    };
    let maps = if protected_pte {
        vec![
            mapping(0, 0, 0x4038, true),
            mapping(0x4038, 0x4038, 8, false),
            mapping(0x4040, 0x4040, 0x7fc0, true),
        ]
    } else {
        vec![
            mapping(0, 0, 0x9000, true),
            mapping(0x9000, 0x9000, 0x1000, data_write),
            mapping(0xa000, 0xa000, 0x2000, true),
        ]
    };
    (
        Image::physical_mapped(
            vec![("ram".into(), bytes)],
            maps,
            MemoryLimits {
                max_backing_bytes: 0xc000,
                max_backings: 1,
                max_mappings: 3,
            },
        )
        .unwrap(),
        State {
            cr3: 0x1000,
            ..State::default()
        },
    )
}

#[test]
fn supervisor_protection_smap_denies_supervisor_operand_data() {
    let (mut image, mut state) = fixture(0, true, false);
    state.cr4 |= 1 << 21;
    let mut work = AccessState::default();
    assert_eq!(
        Memory::new(&mut image, &state, 0, 0, &mut work).read(0x1000, 1),
        Err(AccessFailure::Paging(Failure::Page(PageFault {
            address: 0x1000,
            access: Access::Read,
            error_code: 1,
        })))
    );
}

fn protection_fault(address: u64, access: Access, error_code: u32) -> AccessFailure {
    AccessFailure::Paging(Failure::Page(PageFault {
        address,
        access,
        error_code,
    }))
}

fn write_probe_fixture(leaf: u64, data_write: bool) -> (Image, State) {
    let mut bytes = vec![0; 0xa000];
    for (address, entry) in [
        (0x1000, 0x2007u64),
        (0x2000, 0x3007),
        (0x3000, 0x4007),
        (0x4008, leaf),
    ] {
        bytes[address..address + 8].copy_from_slice(&entry.to_le_bytes());
    }
    bytes[0x9000] = 0xa5;
    let image = Image::physical_mapped(
        vec![("ram".into(), bytes)],
        vec![
            MappingInput {
                base: 0,
                backing: "ram".into(),
                offset: 0,
                length: 0x9000,
                permissions: Permissions {
                    read: true,
                    write: true,
                    execute: true,
                },
            },
            MappingInput {
                base: 0x9000,
                backing: "ram".into(),
                offset: 0x9000,
                length: 1,
                permissions: Permissions {
                    read: false,
                    write: data_write,
                    execute: false,
                },
            },
            MappingInput {
                base: 0xa000,
                backing: "ram".into(),
                offset: 0x9000,
                length: 1,
                permissions: Permissions {
                    read: true,
                    write: false,
                    execute: true,
                },
            },
        ],
        MemoryLimits {
            max_backing_bytes: 0xa000,
            max_backings: 1,
            max_mappings: 3,
        },
    )
    .unwrap();
    (
        image,
        State {
            cr3: 0x1000,
            ..State::default()
        },
    )
}

#[test]
fn probe_write_paging_permits_accessed_without_dirty_capture_or_payload() {
    let (mut image, state) = write_probe_fixture(0x9007, true);
    let leaf_owner = image.register_source([(0x4008, 8)]).unwrap();
    let data_owner = image.register_source([(0xa000, 1)]).unwrap();
    assert!(image.activate(leaf_owner));
    let mut work = AccessState::default();
    {
        let mut memory = Memory::new(&mut image, &state, 3, 2, &mut work);
        assert_eq!(memory.probe_write(0x1000), Ok(()));
        assert!(
            memory.storage.borrow().work.pending.is_empty(),
            "probe must not capture a write"
        );
        assert_eq!(memory.prepare_publication(), Ok(()));
    }
    for (address, value) in [
        (0x1000, 0x2027),
        (0x2000, 0x3027),
        (0x3000, 0x4027),
        (0x4008, 0x9027),
    ] {
        assert_eq!(image.physical_read(address, 8), Ok(value));
    }
    assert!(
        !image.owner_valid(leaf_owner),
        "real A writes invalidate their source aliases"
    );
    assert!(image.active_changed());
    assert!(
        image.owner_valid(data_owner),
        "permission probe is not a payload write"
    );
    assert_eq!(image.physical_read(0xa000, 1), Ok(0xa5));
    assert!(image.activate(data_owner));
    {
        let mut memory = Memory::new(&mut image, &state, 3, 2, &mut work);
        assert_eq!(memory.probe_write(0x1000), Ok(()));
        assert_eq!(memory.prepare_publication(), Ok(()));
    }
    assert!(work.pending.is_empty());
    assert_eq!(image.physical_read(0x4008, 8), Ok(0x9027));
    assert!(image.owner_valid(data_owner));
    assert!(!image.active_changed());
}

#[test]
fn probe_write_paging_preserves_existing_capture_and_private_fault_provenance() {
    use crate::memory::{Cause, Fault};
    use crate::x86::paging::walk::PhysicalFault;

    for (data_write, address, physical, cause) in [
        (false, 0x1000, 0x9000, Cause::Permission),
        (true, 0x1001, 0x9001, Cause::Unmapped),
    ] {
        let (mut image, state) = write_probe_fixture(0x9007, data_write);
        let mut work = AccessState::default();
        let memory = Memory::new(&mut image, &state, 3, 2, &mut work);
        assert_eq!(
            memory.probe_write(address),
            Err(AccessFailure::Paging(Failure::Physical(PhysicalFault {
                linear: address,
                access: Access::Write,
                physical: Fault {
                    address: physical,
                    width: 1,
                    access: Access::Write,
                    cause,
                    failing: u128::from(physical)
                },
                phase: PhysicalPhase::FinalAccess,
            })))
        );
        assert!(memory.storage.borrow().work.pending.is_empty());
    }
    let (mut image, state) = write_probe_fixture(0x9007, true);
    let mut work = AccessState::default();
    let memory = Memory::new(&mut image, &state, 3, 2, &mut work);
    memory.check_write(0x1000, 1).unwrap();
    assert_eq!(memory.probe_write(0x1000), Ok(()));
    let storage = memory.storage.borrow();
    assert_eq!(
        storage.work.pending.len(),
        1,
        "probe must preserve the preceding captured write alone"
    );
    let captured = &storage.work.pending[0];
    assert_eq!(
        (captured.address, captured.width, captured.published),
        (0x1000, 1, false)
    );
    assert_eq!(storage.image.physical_read(0x4008, 8), Ok(0x9027));
}

#[test]
fn probe_write_paging_uses_ordinary_cpl_ac_wp_and_user_rights() {
    for cpl in 0..=2 {
        for ac in [false, true] {
            let (mut image, mut state) = write_probe_fixture(0x9007, true);
            state.cr4 |= 1 << 21;
            let mut work = AccessState::default();
            let memory = Memory::new(&mut image, &state, cpl, u64::from(ac) << 18, &mut work);
            assert_eq!(
                memory.probe_write(0x1000),
                if ac {
                    Ok(())
                } else {
                    Err(protection_fault(0x1000, Access::Write, 3))
                },
                "cpl{cpl} ac{ac}"
            );
            assert!(memory.storage.borrow().work.pending.is_empty());
        }
    }
    for (cpl, wp, leaf, expected) in [
        (0, false, 0x9005, Ok(())),
        (
            0,
            true,
            0x9005,
            Err(protection_fault(0x1000, Access::Write, 3)),
        ),
        (
            3,
            false,
            0x9005,
            Err(protection_fault(0x1000, Access::Write, 7)),
        ),
        (
            3,
            false,
            0x9003,
            Err(protection_fault(0x1000, Access::Write, 7)),
        ),
        (3, false, 0x9007, Ok(())),
    ] {
        let (mut image, mut state) = write_probe_fixture(leaf, true);
        state.cr0 |= u64::from(wp) << 16;
        let mut work = AccessState::default();
        let memory = Memory::new(&mut image, &state, cpl, 2, &mut work);
        assert_eq!(
            memory.probe_write(0x1000),
            expected,
            "cpl{cpl} wp{wp} leaf{leaf:x}"
        );
        assert!(memory.storage.borrow().work.pending.is_empty());
    }
}

#[test]
fn probe_write_paging_does_not_require_dirty_update_permission() {
    let (mut image, state) = fixture(0, true, true);
    let owner = image.register_source([(0x4038, 8)]).unwrap();
    assert!(image.activate(owner));
    let mut work = AccessState::default();
    {
        let mut memory = Memory::new(&mut image, &state, 3, 2, &mut work);
        assert_eq!(memory.probe_write(0x7000), Ok(()));
        assert_eq!(
            memory.prepare_publication(),
            Ok(()),
            "probe cannot admit a D write to the read-only PTE"
        );
    }
    assert!(work.pending.is_empty());
    assert_eq!(image.physical_read(0x4038, 8), Ok(0x7027));
    assert!(image.owner_valid(owner));
    assert!(!image.active_changed());
}

#[test]
fn probe_write_pg0_checks_exact_final_byte_before_high_backing() {
    use crate::memory::{Cause, Fault};
    use crate::x86::paging::walk::PhysicalFault;

    let mut image = Image::physical_mapped(
        vec![("ram".into(), vec![0xa5])],
        [0xffff_ffff, 0x1_0000_0000]
            .into_iter()
            .map(|base| MappingInput {
                base,
                backing: "ram".into(),
                offset: 0,
                length: 1,
                permissions: Permissions {
                    read: false,
                    write: true,
                    execute: false,
                },
            })
            .collect(),
        MemoryLimits {
            max_backing_bytes: 1,
            max_backings: 1,
            max_mappings: 2,
        },
    )
    .unwrap();
    let state = State::reset();
    let mut work = AccessState::default();
    let memory = Memory::new(&mut image, &state, 0, 2, &mut work);
    assert_eq!(memory.probe_write(0xffff_ffff), Ok(()));
    assert_eq!(
        memory.probe_write(0x1_0000_0000),
        Err(AccessFailure::Paging(Failure::Physical(PhysicalFault {
            linear: 0x1_0000_0000,
            access: Access::Write,
            physical: Fault {
                address: 0x1_0000_0000,
                width: 1,
                access: Access::Write,
                cause: Cause::AddressRange,
                failing: 1u128 << 32
            },
            phase: PhysicalPhase::FinalAccess,
        })))
    );
    assert!(memory.storage.borrow().work.pending.is_empty());
}

#[test]
fn publication_geometry_read_and_execute_do_not_allocate() {
    let (mut image, state) = fixture(0, true, false);
    let mut work = AccessState::default();
    let memory = Memory::new(&mut image, &state, 3, 2, &mut work);
    let geometry: Vec<_> = [Access::Read, Access::Execute]
        .into_iter()
        .map(|access| {
            let prepared = memory
                .prepare(0x1000, 8, access, false, memory.class)
                .unwrap();
            (access, prepared.fields.capacity(), prepared.fields.len())
        })
        .collect();
    assert_eq!(
        geometry,
        vec![(Access::Read, 0, 0), (Access::Execute, 0, 0)],
        "read/execute preparation must not allocate publication geometry"
    );
}

#[test]
fn publication_geometry_write_rmw_and_sparse_intent_stays_exact() {
    let (mut image, state) = fixture(0, true, false);
    let mut work = AccessState::default();
    let mut memory = Memory::new(&mut image, &state, 3, 2, &mut work);
    for rmw in [false, true] {
        let prepared = memory
            .prepare(0x1000, 8, Access::Write, rmw, memory.class)
            .unwrap();
        assert_eq!(prepared.fields, [(0, 8)], "write/rmw{rmw} geometry");
    }
    assert_eq!(memory.read_for_write(0x1000, 8).unwrap(), 0);
    assert_eq!(memory.storage.borrow().work.pending[0].fields, [(0, 8)]);
    memory.prepare_publication().unwrap();
    assert_eq!(
        memory
            .storage
            .borrow()
            .image
            .physical_read(0x4008, 8)
            .unwrap(),
        0x9067
    );
    memory.storage.borrow_mut().work.clear();
    for fields in [
        vec![(0, 8)],
        vec![(5, 1)],
        vec![],
        vec![(5, 1), (0, 1)],
        vec![(0, 8), (0, 8)],
    ] {
        memory
            .storage
            .borrow_mut()
            .image
            .physical_write(0x4008, 8, 0x9027)
            .unwrap();
        memory
            .capture_write_fields(0x1000, 8, &fields, memory.class)
            .unwrap();
        assert_eq!(
            memory.storage.borrow().work.pending.last().unwrap().fields,
            fields
        );
        memory.prepare_publication().unwrap();
        assert_eq!(
            memory
                .storage
                .borrow()
                .image
                .physical_read(0x4008, 8)
                .unwrap(),
            if fields.is_empty() { 0x9027 } else { 0x9067 }
        );
        memory.storage.borrow_mut().work.clear();
    }
    memory
        .storage
        .borrow_mut()
        .image
        .physical_write(0x4008, 8, 0x9027)
        .unwrap();
    for fields in [vec![], vec![(0, 1)]] {
        assert_eq!(
            memory.capture_write_fields(0x1ff8, 16, &fields, memory.class),
            Err(protection_fault(0x2000, Access::Write, 6))
        );
        assert!(memory.storage.borrow().work.pending.is_empty());
        assert_eq!(
            memory
                .storage
                .borrow()
                .image
                .physical_read(0x4008, 8)
                .unwrap(),
            0x9027
        );
    }
    assert_eq!(
        memory
            .storage
            .borrow()
            .image
            .physical_read(0x9000, 8)
            .unwrap(),
        0
    );
}

#[test]
fn smap_uses_live_ac_for_explicit_data_but_never_exempts_system_metadata() {
    for cpl in 0..4 {
        for ac in [0, 1 << 18] {
            let (mut image, mut state) = fixture(0, true, false);
            state.cr4 |= 1 << 21;
            image.physical_write(0x9000, 1, 0x5a).unwrap();
            let mut work = AccessState::default();
            let mut memory = Memory::new(&mut image, &state, cpl, ac | 2, &mut work);
            let allowed = cpl == 3 || ac != 0;
            assert_eq!(
                memory.read(0x1000, 1),
                if allowed {
                    Ok(0x5a)
                } else {
                    Err(protection_fault(0x1000, Access::Read, 1))
                },
                "CPL{cpl}/AC{ac:x} explicit read"
            );
            assert_eq!(
                memory.write(0x1000, 1, 0xa5),
                if allowed {
                    Ok(())
                } else {
                    Err(protection_fault(0x1000, Access::Write, 3))
                },
                "CPL{cpl}/AC{ac:x} explicit write"
            );
            assert_eq!(
                memory.read_system(0x1000, 8),
                Err(protection_fault(0x1000, Access::Read, 1)),
                "CPL{cpl}/AC{ac:x} implicit read"
            );
            assert_eq!(
                memory.check_system_write(0x1000, 1),
                Err(protection_fault(0x1000, Access::Write, 3)),
                "CPL{cpl}/AC{ac:x} implicit write"
            );
        }
    }
}

#[test]
fn smap_frame_payload_uses_prospective_privilege_and_its_captured_admission() {
    for ac in [0, 1 << 18] {
        for origin in [0, 3] {
            for destination in 0..4 {
                let (mut image, mut state) = fixture(0, true, false);
                state.cr4 |= 1 << 21;
                let mut work = AccessState::default();
                {
                    let mut memory = Memory::new(&mut image, &state, origin, 2 | ac, &mut work);
                    let admitted = memory.check_frame_write(0x1000, 8, destination);
                    assert_eq!(
                        admitted,
                        if destination == 3 || ac != 0 {
                            Ok(())
                        } else {
                            Err(protection_fault(0x1000, Access::Write, 3))
                        },
                        "origin{origin}/destination{destination}/AC{ac:x}"
                    );
                    if admitted.is_ok() {
                        memory.prepare_publication().unwrap();
                        memory.write(0x1000, 8, 0x123456789abcdef0).unwrap();
                    }
                }
                assert_eq!(
                    image.physical_read(0x9000, 8).unwrap(),
                    if destination == 3 || ac != 0 {
                        0x123456789abcdef0
                    } else {
                        0
                    }
                );
            }
        }
    }
}

#[test]
fn smap_does_not_turn_a_permitted_read_into_rmw_write_admission() {
    let (mut image, mut state) = fixture(0, true, false);
    state.cr4 |= 1 << 21;
    state.cr0 |= 1 << 16;
    image.physical_write(0x4008, 8, 0x9025).unwrap();
    let mut work = AccessState::default();
    let memory = Memory::new(&mut image, &state, 0, 0x40002, &mut work);
    assert_eq!(memory.read(0x1000, 8), Ok(0));
    assert_eq!(
        memory.read_for_write(0x1000, 8),
        Err(protection_fault(0x1000, Access::Write, 3))
    );
}

#[test]
fn smap_checks_full_image_span_but_dirties_only_selected_payload_pages() {
    for ac in [0, 1 << 18] {
        let (mut image, mut state) = fixture(0xb027, true, false);
        state.cr4 |= 1 << 21;
        image.physical_write(0x4008, 8, 0x9023).unwrap();
        let mut work = AccessState::default();
        let result = Memory::new(&mut image, &state, 0, ac | 2, &mut work).write_fields(
            0x1ee0,
            512,
            &[(0, 288)],
            &[0xa5; 512],
        );
        assert_eq!(
            result,
            if ac != 0 {
                Ok(())
            } else {
                Err(protection_fault(0x2000, Access::Write, 3))
            }
        );
        assert_eq!(
            image.physical_read_bytes(0x9ee0, 288).unwrap(),
            vec![if ac != 0 { 0xa5 } else { 0 }; 288]
        );
        assert_eq!(
            image.physical_read_bytes(0xb000, 224).unwrap(),
            vec![0; 224]
        );
        assert_eq!(
            image.physical_read(0x4008, 8).unwrap(),
            if ac != 0 { 0x9063 } else { 0x9023 }
        );
        assert_eq!(image.physical_read(0x4010, 8).unwrap(), 0xb027);
    }
}

#[test]
fn later_page_fault_publishes_no_cross_page_payload_or_dirty_bits() {
    let (mut image, state) = fixture(0, true, false);
    let mut work = AccessState::default();
    let error = Memory::new(&mut image, &state, 3, 0, &mut work)
        .write(0x1ffe, 4, 0xaabbccdd)
        .unwrap_err();
    assert_eq!(
        error,
        AccessFailure::Paging(Failure::Page(PageFault {
            address: 0x2000,
            access: Access::Write,
            error_code: 6
        }))
    );
    assert_eq!(image.physical_read(0x9ffe, 2).unwrap(), 0);
    assert_eq!(image.physical_read(0x4008, 8).unwrap(), 0x9027);
}

#[test]
fn earlier_private_payload_refusal_precedes_next_missing_page() {
    let (mut image, state) = fixture(0, false, false);
    let mut work = AccessState::default();
    let error = Memory::new(&mut image, &state, 3, 0, &mut work)
        .write(0x1ffe, 4, 0xaabbccdd)
        .unwrap_err();
    let AccessFailure::Paging(Failure::Physical(error)) = error else {
        panic!("private physical refusal required")
    };
    assert_eq!(
        (error.linear, error.physical.failing, error.phase),
        (0x1ffe, 0x9ffe, PhysicalPhase::FinalAccess)
    );
    assert_eq!(image.physical_read(0x4010, 8).unwrap(), 0);
}

#[test]
fn nonadjacent_fragments_write_exact_bytes_after_all_dirty_admission() {
    let (mut image, state) = fixture(0xb027, true, false);
    let mut work = AccessState::default();
    Memory::new(&mut image, &state, 3, 0, &mut work)
        .write(0x1ffe, 4, 0xaabbccdd)
        .unwrap();
    assert_eq!(image.physical_read(0x9ffe, 2).unwrap(), 0xccdd);
    assert_eq!(image.physical_read(0xb000, 2).unwrap(), 0xaabb);
    assert_eq!(image.physical_read(0xa000, 2).unwrap(), 0);
    assert_eq!(image.physical_read(0x4008, 8).unwrap(), 0x9067);
    assert_eq!(image.physical_read(0x4010, 8).unwrap(), 0xb067);
}

#[test]
fn prepared_frame_dirty_refusal_cannot_leak_earlier_slots_or_dirty_updates() {
    let (mut image, state) = fixture(0, true, true);
    let mut work = AccessState::default();
    let mut memory = Memory::new(&mut image, &state, 0, 0, &mut work);
    memory.check_frame_write(0x8008, 8, 0).unwrap();
    memory.check_frame_write(0x7ff8, 8, 0).unwrap();
    let error = memory.prepare_publication().unwrap_err();
    assert!(
        matches!(error,AccessFailure::Paging(Failure::Physical(f)) if f.phase==PhysicalPhase::DirtyWrite && f.physical.failing==0x4038)
    );
    assert_eq!(image.physical_read(0x8008, 8).unwrap(), 0);
    assert_eq!(image.physical_read(0x7ff8, 8).unwrap(), 0);
    assert_eq!(image.physical_read(0x4040, 8).unwrap(), 0x8027);
}

#[test]
fn rmw_retains_its_leaf_and_payload_may_clear_the_planned_dirty_bit() {
    let (mut image, state) = fixture(0, true, false);
    image.physical_write(0x4008, 8, 0x4027).unwrap();
    let mut work = AccessState::default();
    {
        let mut memory = Memory::new(&mut image, &state, 0, 0, &mut work);
        assert_eq!(memory.read_for_write(0x1008, 8).unwrap(), 0x4027);
        memory.write(0x1008, 8, 0xa027).unwrap();
    }
    assert_eq!(image.physical_read(0x4008, 8).unwrap(), 0xa027);
    assert_eq!(image.physical_read(0xa008, 8).unwrap(), 0);
    assert_eq!(
        Memory::new(&mut image, &state, 0, 0, &mut work)
            .read(0x1008, 8)
            .unwrap(),
        0
    );
}

#[test]
fn sparse_nominal_probe_dirties_only_a_participating_page() {
    let (mut image, state) = fixture(0xb027, true, false);
    let mut work = AccessState::default();
    Memory::new(&mut image, &state, 3, 0, &mut work)
        .write_fields(0x1ff0, 32, &[(0, 2)], &[0x55; 32])
        .unwrap();
    assert_eq!(image.physical_read(0x4008, 8).unwrap(), 0x9067);
    assert_eq!(image.physical_read(0x4010, 8).unwrap(), 0xb027);
}
#[test]
fn ordered_dirty_refusal_identifies_duplicate_spans_and_discards_the_failed_batch() {
    let mut bytes = vec![0xa5; 0xc000];
    bytes[0x1000..0x1004].copy_from_slice(&0x20023_u32.to_le_bytes());
    bytes[0x2004..0x2008].copy_from_slice(&0xa063_u32.to_le_bytes());
    let mapping = |base, offset, length, write| MappingInput {
        base,
        offset,
        length,
        backing: "ram".into(),
        permissions: Permissions {
            read: true,
            write,
            execute: false,
        },
    };
    let mut image = Image::physical_mapped(
        vec![("ram".into(), bytes)],
        vec![
            mapping(0, 0, 0xc000, true),
            mapping(0x20000, 0x2000, 0x1000, false),
            mapping(0x30000, 0x2000, 0x1000, true),
        ],
        MemoryLimits {
            max_backing_bytes: 0xc000,
            max_backings: 1,
            max_mappings: 3,
        },
    )
    .unwrap();
    let state = State {
        cr0: 0x80010033,
        cr3: 0x1000,
        cr4: 0x608,
        efer: 0,
        ..State::default()
    };
    let mut work = AccessState::default();
    // The same nominal span is admitted twice under distinct captured translations.
    Memory::new(&mut image, &state, 0, 0, &mut work)
        .check_system_write(0x1005, 1)
        .unwrap();
    image.physical_write(0x30004, 4, 0xb023).unwrap();
    let mut memory = Memory::new(&mut image, &state, 0, 0, &mut work);
    memory.check_system_write(0x1005, 1).unwrap();
    let error = memory.prepare_publication_ordered().unwrap_err();
    assert_eq!(
        error.index,
        Some(1),
        "address and width cannot identify this owner"
    );
    assert!(
        matches!(error.failure, AccessFailure::Paging(Failure::Physical(f))
        if f.linear == 0x1005 && f.phase == PhysicalPhase::DirtyWrite
            && f.physical.address == 0x20004 && f.physical.cause == crate::memory::Cause::Permission)
    );
    memory.prepare_publication_ordered().unwrap();
    assert_eq!(
        image.physical_read(0x20004, 4).unwrap(),
        0xb023,
        "no stale D publication"
    );
    assert_eq!(image.physical_read(0xa005, 1).unwrap(), 0xa5);
    assert_eq!(image.physical_read(0xb005, 1).unwrap(), 0xa5);
}

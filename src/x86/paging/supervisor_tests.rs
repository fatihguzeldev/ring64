use super::*;
use crate::memory::{MappingInput, MemoryLimits, Permissions};

#[derive(Clone, Copy, Debug)]
enum Family {
    NonPae,
    Pae,
    Ia32e,
}

fn fixture(family: Family) -> (Image, State, u64, u64, u32) {
    let mut image = Image::physical_mapped(
        vec![("ram".into(), vec![0; 0xa000])],
        vec![MappingInput {
            base: 0,
            backing: "ram".into(),
            offset: 0,
            length: 0xa000,
            permissions: Permissions {
                read: true,
                write: true,
                execute: true,
            },
        }],
        MemoryLimits {
            max_backing_bytes: 0xa000,
            max_backings: 1,
            max_mappings: 1,
        },
    )
    .unwrap();
    let mut state = State {
        cr3: 0x1000,
        ..State::default()
    };
    let (upper, leaf, width) = match family {
        Family::NonPae => {
            state.cr4 = 0x608;
            state.efer = 0;
            image.physical_write(0x1000, 4, 0x2027).unwrap();
            (0x1000, 0x2004, 4)
        }
        Family::Pae => {
            state.efer = 0;
            state.pdpte = Some([0x2001, 0, 0, 0]);
            image.physical_write(0x2000, 8, 0x3027).unwrap();
            (0x2000, 0x3008, 8)
        }
        Family::Ia32e => {
            image.physical_write(0x1000, 8, 0x2027).unwrap();
            image.physical_write(0x2000, 8, 0x3027).unwrap();
            image.physical_write(0x3000, 8, 0x4027).unwrap();
            (0x3000, 0x4008, 8)
        }
    };
    image.physical_write(leaf, width, 0x9027).unwrap();
    (image, state, upper, leaf, width)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LogicalClass {
    User,
    Supervisor,
    ImplicitSupervisor,
}

// Preserve independent logical inputs; only construct the new private request shape.
fn request(linear: u64, access: Access, class: LogicalClass, ac: bool) -> Request {
    Request {
        linear,
        access,
        class: match class {
            LogicalClass::User => AccessClass::User,
            LogicalClass::Supervisor => AccessClass::Supervisor { ac },
            LogicalClass::ImplicitSupervisor => AccessClass::ImplicitSupervisor,
        },
    }
}

// Independent access-rights table, deliberately unlike the combined walk predicate.
fn table(
    class: LogicalClass,
    access: Access,
    page_user: bool,
    page_write: bool,
    nx: bool,
    controls: [bool; 4],
) -> bool {
    let [wp, smep, smap, ac] = controls;
    if class == LogicalClass::User {
        return page_user
            && match access {
                Access::Read => true,
                Access::Write => page_write,
                Access::Execute => !nx,
            };
    }
    if !page_user {
        return match access {
            Access::Read => true,
            Access::Write => !wp || page_write,
            Access::Execute => !nx,
        };
    }
    if access == Access::Execute {
        return !smep && !nx;
    }
    if smap && (!ac || class == LogicalClass::ImplicitSupervisor) {
        return false;
    }
    access != Access::Write || !wp || page_write
}

#[test]
fn independent_supervisor_rights_table_matches_all_three_walk_families() {
    let mut cases = 0;
    for family in [Family::NonPae, Family::Pae, Family::Ia32e] {
        let (mut image, original, upper, leaf, width) = fixture(family);
        let upper_base = image.physical_read(upper, width).unwrap() & !7;
        for class in [
            LogicalClass::User,
            LogicalClass::Supervisor,
            LogicalClass::ImplicitSupervisor,
        ] {
            for access in [Access::Read, Access::Write, Access::Execute] {
                if class == LogicalClass::ImplicitSupervisor && access == Access::Execute {
                    continue;
                }
                for bits in 0u16..1024 {
                    let bit = |n: u32| bits & (1u16 << n) != 0;
                    let (upper_user, leaf_user, upper_write, leaf_write) =
                        (bit(0), bit(1), bit(2), bit(3));
                    let (xd, nxe, wp, smep, smap, ac) =
                        (bit(4), bit(5), bit(6), bit(7), bit(8), bit(9));
                    if matches!(family, Family::NonPae) && xd
                        || !matches!(family, Family::NonPae) && xd && !nxe
                    {
                        continue;
                    }
                    image
                        .physical_write(
                            upper,
                            width,
                            upper_base
                                | 1
                                | u64::from(upper_write) << 1
                                | u64::from(upper_user) << 2,
                        )
                        .unwrap();
                    image
                        .physical_write(
                            leaf,
                            width,
                            0x9021
                                | u64::from(leaf_write) << 1
                                | u64::from(leaf_user) << 2
                                | u64::from(xd) << 63,
                        )
                        .unwrap();
                    let state = State {
                        cr0: original.cr0 | u64::from(wp) << 16,
                        cr4: original.cr4 | u64::from(smep) << 20 | u64::from(smap) << 21,
                        efer: original.efer | u64::from(nxe) << 11,
                        ..original
                    };
                    let allowed = table(
                        class,
                        access,
                        upper_user && leaf_user,
                        upper_write && leaf_write,
                        xd,
                        [wp, smep, smap, ac],
                    );
                    let expected = if allowed {
                        Ok(0x9234)
                    } else {
                        Err(Failure::Page(PageFault {
                            address: 0x1234,
                            access,
                            error_code: 1
                                | u32::from(access == Access::Write) << 1
                                | u32::from(class == LogicalClass::User) << 2
                                | u32::from(
                                    access == Access::Execute
                                        && (smep || !matches!(family, Family::NonPae) && nxe),
                                ) << 4,
                        }))
                    };
                    assert_eq!(
                        peek(&image, &state, request(0x1234, access, class, ac),)
                            .map(|translation| translation.physical),
                        expected,
                        "independent supervisor rights table: {family:?}/{class:?}/{access:?}/{bits:x}"
                    );
                    cases += 1;
                }
            }
        }
    }
    assert_eq!(cases, 16_384);
}

#[test]
fn every_ia32e_level_contributes_to_supervisor_page_classification() {
    for level in [0x1000, 0x2000, 0x3000, 0x4008] {
        let (mut image, mut state, _, _, _) = fixture(Family::Ia32e);
        state.cr4 |= CR4_SMEP | CR4_SMAP;
        let old = image.physical_read(level, 8).unwrap();
        image.physical_write(level, 8, old & !4).unwrap();
        for (class, access) in [
            (LogicalClass::Supervisor, Access::Execute),
            (LogicalClass::ImplicitSupervisor, Access::Read),
        ] {
            assert_eq!(
                peek(&image, &state, request(0x1234, access, class, false),)
                    .unwrap()
                    .physical,
                0x9234,
                "supervisor page at level {level:x}"
            );
        }
    }
}

#[test]
fn supervisor_protection_applies_to_every_admitted_large_leaf() {
    for (family, leaf, entry, pse) in [
        (Family::NonPae, 0x1000, 0x87, true),
        (Family::Pae, 0x2000, 0x87, false),
        (Family::Ia32e, 0x3000, 0x87, false),
        (Family::Ia32e, 0x2000, 0x87, false),
    ] {
        let (mut image, mut state, _, _, width) = fixture(family);
        image.physical_write(leaf, width, entry).unwrap();
        state.cr4 |= CR4_SMEP | CR4_SMAP | if pse { 0x10 } else { 0 };
        for (class, access, ac, expected) in [
            (LogicalClass::Supervisor, Access::Execute, true, Some(0x11)),
            (LogicalClass::Supervisor, Access::Read, false, Some(1)),
            (
                LogicalClass::ImplicitSupervisor,
                Access::Read,
                true,
                Some(1),
            ),
            (LogicalClass::Supervisor, Access::Read, true, None),
            (LogicalClass::User, Access::Execute, false, None),
        ] {
            let result = peek(&image, &state, request(0x1234, access, class, ac));
            if let Some(error_code) = expected {
                assert_eq!(
                    result,
                    Err(Failure::Page(PageFault {
                        address: 0x1234,
                        access,
                        error_code,
                    })),
                    "{family:?}/leaf{leaf:x}/{class:?}/{access:?}"
                );
            } else {
                assert_eq!(result.unwrap().physical, 0x1234);
            }
        }
    }
}

#[test]
fn reached_protection_denial_keeps_accessed_effects_but_no_dirty_update() {
    for (class, ac) in [
        (LogicalClass::Supervisor, false),
        (LogicalClass::ImplicitSupervisor, true),
    ] {
        let (mut image, mut state, _, _, _) = fixture(Family::Ia32e);
        state.cr4 |= CR4_SMAP;
        for level in [0x1000, 0x2000, 0x3000, 0x4008] {
            let old = image.physical_read(level, 8).unwrap();
            image.physical_write(level, 8, old & !32).unwrap();
        }
        assert_eq!(
            walk(
                &mut image,
                &state,
                request(0x1234, Access::Write, class, ac),
            ),
            Err(Failure::Page(PageFault {
                address: 0x1234,
                access: Access::Write,
                error_code: 3,
            }))
        );
        for (level, expected) in [
            (0x1000, 0x2027),
            (0x2000, 0x3027),
            (0x3000, 0x4027),
            (0x4008, 0x9027),
        ] {
            assert_eq!(image.physical_read(level, 8).unwrap(), expected);
        }
    }
}

#[test]
fn lower_structural_faults_precede_smap_and_smep_permission_denial() {
    for (leaf_word, error_code) in [(0, 0x10), (1 << 63 | 0x9007, 0x19)] {
        let (mut image, mut state, _, leaf, _) = fixture(Family::Ia32e);
        state.cr4 |= CR4_SMEP | CR4_SMAP;
        image.physical_write(leaf, 8, leaf_word).unwrap();
        assert_eq!(
            walk(
                &mut image,
                &state,
                request(0x1234, Access::Execute, LogicalClass::Supervisor, false),
            ),
            Err(Failure::Page(PageFault {
                address: 0x1234,
                access: Access::Execute,
                error_code,
            }))
        );
    }
}

#[test]
fn inactive_paging_ignores_supervisor_permissions_without_inventing_table_work() {
    let (image, mut state, _, _, _) = fixture(Family::NonPae);
    state.cr0 &= !(1 << 31);
    state.cr4 |= CR4_SMEP | CR4_SMAP;
    physical_counts::take();
    for class in [
        LogicalClass::User,
        LogicalClass::Supervisor,
        LogicalClass::ImplicitSupervisor,
    ] {
        for access in [Access::Read, Access::Write, Access::Execute] {
            if class == LogicalClass::ImplicitSupervisor && access == Access::Execute {
                continue;
            }
            for ac in [false, true] {
                let translation = peek(&image, &state, request(0x1234, access, class, ac)).unwrap();
                assert_eq!(translation.physical, 0x1234);
                assert_eq!(translation.entry_width, 0);
                assert!(!translation.dirty);
                assert!(translation.entries().is_empty());
            }
        }
    }
    assert_eq!(physical_counts::take(), [0; 6]);
}

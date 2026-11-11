use super::*;
use crate::memory::{Image, MappingInput, MemoryLimits, Permissions};

fn legacy(pae: bool) -> State {
    State {
        cr0: 0x80000033,
        cr3: 0x1018,
        cr4: if pae { 0x628 } else { 0x608 },
        efer: 0,
        pdpte: pae.then_some([0x3001, 0, 0, 0]),
        ..State::default()
    }
}
#[test]
fn physical_import_preserves_raw_control_bits_and_conditional_quartet() {
    for pae in [false, true] {
        let bank = State {
            cr3: 0x0008000000001038,
            cr2: u64::MAX,
            ..legacy(pae)
        };
        assert_eq!(bank.validate_physical(Mode::Protected), Ok(()));
        assert_eq!(bank.validate_physical(Mode::Virtual8086), Ok(()));
        assert!(bank.validate_physical(Mode::Long64).is_err());
        assert!(
            State {
                pdpte: if pae { None } else { Some([0; 4]) },
                ..bank
            }
            .validate_physical(Mode::Protected)
            .is_err()
        );
    }
    for bad in [0x3003, 0x3021, 0x0010000000003001, 0x8000000000003001] {
        let mut bank = legacy(true);
        bank.pdpte.as_mut().unwrap()[3] = bad;
        assert!(bank.validate_physical(Mode::Protected).is_err());
    }
    for good in [0x3001, 0x3019, 0x3e01, 0xfffffffffffffffe] {
        let mut bank = legacy(true);
        bank.pdpte.as_mut().unwrap()[3] = good;
        assert_eq!(bank.validate_physical(Mode::Protected), Ok(()));
    }
}
#[test]
fn guest_legacy_control_writes_normalize_root_without_host_normalization() {
    assert_eq!(
        legacy(false)
            .prepare_physical_cr_write(3, 0x1fff, Mode::Protected)
            .unwrap()
            .cr3,
        0x1018
    );
    for (input, expected) in [(0x101f, 0x1000), (0x103f, 0x1020), (0xffffffff, 0xffffffe0)] {
        assert_eq!(
            legacy(true)
                .prepare_physical_cr_write(3, input, Mode::Protected)
                .unwrap()
                .cr3,
            expected
        );
    }
    assert_eq!(
        legacy(false)
            .prepare_physical_cr_write(4, 0x628, Mode::Protected)
            .unwrap()
            .cr4,
        0x628
    );
    assert_eq!(
        legacy(false).prepare_physical_cr_write(0, 0x80000032, Mode::Protected),
        Err(ControlFailure::GeneralProtection)
    );
    assert_eq!(
        legacy(true).prepare_physical_efer_write(0x100),
        Err(ControlFailure::GeneralProtection)
    );
    assert_eq!(
        legacy(true)
            .prepare_physical_efer_write(0xc01)
            .unwrap()
            .efer,
        0x801
    );
}
#[test]
fn capture_reads_all_four_slots_before_reserved_validation() {
    let bytes = [0x3003u64, 0, 0, 0x4001]
        .into_iter()
        .flat_map(u64::to_le_bytes)
        .collect();
    let mut image = Image::physical_mapped(
        vec![("pdpt".into(), bytes)],
        vec![MappingInput {
            base: 0x1000,
            backing: "pdpt".into(),
            offset: 0,
            length: 24,
            permissions: Permissions {
                read: true,
                write: false,
                execute: false,
            },
        }],
        MemoryLimits {
            max_backing_bytes: 32,
            max_backings: 1,
            max_mappings: 2,
        },
    )
    .unwrap();
    let state = State {
        cr3: 0x1000,
        ..legacy(true)
    };
    assert!(matches!(
        state.load_pdpte(&image),
        Err(PdpteFailure::Physical { slot: 3, .. })
    ));
    image
        .set_mappings(vec![MappingInput {
            base: 0x1000,
            backing: "pdpt".into(),
            offset: 0,
            length: 32,
            permissions: Permissions {
                read: true,
                write: false,
                execute: false,
            },
        }])
        .unwrap();
    assert_eq!(state.load_pdpte(&image), Err(PdpteFailure::Reserved));
    image
        .set_mappings(vec![MappingInput {
            base: 0x1000,
            backing: "pdpt".into(),
            offset: 0,
            length: 32,
            permissions: Permissions {
                read: true,
                write: true,
                execute: false,
            },
        }])
        .unwrap();
    image.physical_write(0x1000, 8, 0x3001).unwrap();
    assert_eq!(state.load_pdpte(&image), Ok([0x3001, 0, 0, 0x4001]));
}

#[test]
fn physical_paging_inherits_all_numeric_controls_without_translation_changes() {
    for bits in 0u8..32 {
        for pae in [false, true] {
            let state = State {
                cr0: 0x80000031 | u64::from(bits & 7) << 1,
                cr4: 8 | if pae { 0x20 } else { 0 } | u64::from((bits >> 3) & 3) << 9,
                efer: 0,
                pdpte: pae.then_some([0; 4]),
                ..State::default()
            };
            assert_eq!(
                state.validate_physical(Mode::Protected),
                Ok(()),
                "numeric{bits}/PAE{pae}"
            );
            let cr0 = state
                .prepare_physical_cr_write(0, state.cr0 ^ 0xe, Mode::Protected)
                .unwrap();
            assert!(!state.translation_changed(cr0));
            let cr4 = state
                .prepare_physical_cr_write(4, state.cr4 ^ 0x600, Mode::Protected)
                .unwrap();
            assert!(!state.translation_changed(cr4));
        }
    }
}

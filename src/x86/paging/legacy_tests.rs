use super::*;
use crate::memory::{MappingInput, MemoryLimits, Permissions};

fn image(words: &[(u64, u64, u32)]) -> Image {
    let backings = words
        .iter()
        .enumerate()
        .map(|(i, &(_, word, width))| {
            (
                format!("entry{i}"),
                word.to_le_bytes()[..width as usize].to_vec(),
            )
        })
        .collect();
    let mappings = words
        .iter()
        .enumerate()
        .map(|(i, &(base, _, length))| MappingInput {
            base,
            backing: format!("entry{i}"),
            offset: 0,
            length,
            permissions: Permissions {
                read: true,
                write: true,
                execute: false,
            },
        })
        .collect();
    Image::physical_mapped(
        backings,
        mappings,
        MemoryLimits {
            max_backing_bytes: 1024,
            max_backings: 32,
            max_mappings: 32,
        },
    )
    .unwrap()
}
fn legacy(pae: bool) -> State {
    State {
        cr0: 0x80000033,
        cr3: 0x1000,
        cr4: if pae { 0x628 } else { 0x608 },
        efer: 0,
        pdpte: pae.then_some([0; 4]),
        ..State::default()
    }
}
fn request(linear: u64, access: Access, user: bool) -> Request {
    Request {
        linear,
        access,
        class: AccessClass::operand(if user { 3 } else { 0 }, false),
    }
}
fn pf(linear: u64, access: Access, error_code: u32) -> Failure {
    Failure::Page(PageFault {
        address: linear,
        access,
        error_code,
    })
}

#[test]
fn supervisor_protection_smep_denies_nonpae_user_fetch() {
    let image = image(&[(0x1000, 0x2007, 4), (0x2010, 0x5007, 4)]);
    let state = State {
        cr4: 0x00100608,
        ..legacy(false)
    };
    assert_eq!(
        peek(&image, &state, request(0x4000, Access::Execute, false)),
        Err(pf(0x4000, Access::Execute, 0x11))
    );
}

#[test]
fn supervisor_protection_smep_marks_all_nonpae_fetch_faults_as_instructions() {
    for (user, code) in [(false, 0x10), (true, 0x14)] {
        let mut image = image(&[(0x1000, 0x2007, 4), (0x2010, 0, 4)]);
        let state = State {
            cr4: 0x00100608,
            ..legacy(false)
        };
        assert_eq!(
            walk(&mut image, &state, request(0x4000, Access::Execute, user)),
            Err(pf(0x4000, Access::Execute, code))
        );
    }
}

#[test]
fn supervisor_protection_nonpae_reserved_large_fetch_keeps_reserved_priority() {
    for (smep, code) in [(0, 9), (1 << 20, 0x19)] {
        let mut image = image(&[(0x1004, 0x00200087, 4)]);
        let state = State {
            cr4: 0x618 | smep,
            ..legacy(false)
        };
        assert_eq!(
            walk(
                &mut image,
                &state,
                request(0x400000, Access::Execute, false)
            ),
            Err(pf(0x400000, Access::Execute, code))
        );
        assert_eq!(image.physical_read(0x1004, 4).unwrap(), 0x00200087);
    }
}

#[test]
fn nonpae_literal_walk_uses_exact_dword_entries_and_preserves_adjacent_holes() {
    let mut image = image(&[(0x1120, 0x2007, 4), (0x2d14, 0x9a007, 4)]);
    let state = State {
        cr3: 0x1018,
        ..legacy(false)
    };
    let result = walk(&mut image, &state, request(0x12345678, Access::Read, true)).unwrap();
    assert_eq!(
        (result.physical, result.leaf, result.entry_width),
        (0x9a678, 0x2d14, 4)
    );
    assert_eq!(result.entries(), &[0x1120, 0x2d14]);
    assert_eq!(image.physical_read(0x1120, 4).unwrap(), 0x2027);
    assert_eq!(image.physical_read(0x2d14, 4).unwrap(), 0x9a027);
    assert!(image.physical_read(0x2d18, 1).is_err());
}

#[test]
fn nonpae_permissions_and_lower_nonpresent_keep_literal_pf_priority() {
    for (user, wp, expected) in [
        (true, false, Some(7)),
        (false, true, Some(3)),
        (false, false, None),
    ] {
        let mut image = image(&[(0x1120, 0x2007, 4), (0x2d14, 0x9a005, 4)]);
        let state = State {
            cr0: 0x80000033 | (u64::from(wp) << 16),
            ..legacy(false)
        };
        let result = walk(&mut image, &state, request(0x12345678, Access::Write, user));
        if let Some(code) = expected {
            assert_eq!(result, Err(pf(0x12345678, Access::Write, code)));
        } else {
            assert_eq!(result.unwrap().physical, 0x9a678);
        }
        assert_eq!(image.physical_read(0x2d14, 4).unwrap() & DIRTY, 0);
    }
    let mut image = image(&[(0x1120, 0x2003, 4), (0x2d14, 0xfffffffe, 4)]);
    assert_eq!(
        walk(
            &mut image,
            &legacy(false),
            request(0x12345678, Access::Read, true)
        ),
        Err(pf(0x12345678, Access::Read, 4))
    );
    assert_eq!(image.physical_read(0x1120, 4).unwrap(), 0x2023);
}

#[test]
fn pse36_high_bits_pat_and_reserved_bit_have_independent_literals() {
    let state = State {
        cr4: 0x618,
        ..legacy(false)
    };
    let mut image = image(&[(0x1810, 0x00557087, 4)]);
    assert_eq!(
        walk(&mut image, &state, request(0x81234567, Access::Read, true))
            .unwrap()
            .physical,
        0xab00634567
    );
    image.physical_write(0x1810, 4, 0x00757087).unwrap();
    assert_eq!(
        walk(&mut image, &state, request(0x81234567, Access::Read, true)),
        Err(pf(0x81234567, Access::Read, 0xd))
    );
}

#[test]
fn pse_zero_ignores_ps_while_pse_one_selects_pse36_leaf() {
    let image = image(&[(0x1120, 0x2087, 4), (0x2d14, 0x9a007, 4)]);
    assert_eq!(
        peek(
            &image,
            &legacy(false),
            request(0x12345678, Access::Read, true)
        )
        .unwrap()
        .physical,
        0x9a678
    );
    let large = State {
        cr4: 0x618,
        ..legacy(false)
    };
    assert_eq!(
        peek(&image, &large, request(0x12345678, Access::Read, true))
            .unwrap()
            .physical,
        0x100345678
    );
}

#[test]
fn pae_uses_latched_roots_and_only_two_live_qword_levels() {
    let mut state = legacy(true);
    state.pdpte.as_mut().unwrap()[3] = 0x0001000000003001;
    let mut image = image(&[
        (0x0001000000003048, 0x0002000000004007, 8),
        (0x00020000000041a0, 0x000300000009a007, 8),
    ]);
    let result = walk(&mut image, &state, request(0xc1234567, Access::Read, true)).unwrap();
    assert_eq!(
        (result.physical, result.entry_width),
        (0x000300000009a567, 8)
    );
    assert_eq!(result.entries(), &[0x0001000000003048, 0x00020000000041a0]);
    assert!(image.physical_read(state.cr3, 1).is_err());
    state.pdpte.as_mut().unwrap()[3] = 0xfffffffffffffffe;
    assert_eq!(
        walk(&mut image, &state, request(0xc1234567, Access::Read, true)),
        Err(pf(0xc1234567, Access::Read, 4))
    );
}

#[test]
fn pae_large_leaf_ignores_pse_but_checks_high_reserved_address_and_nx() {
    let mut state = legacy(true);
    state.pdpte.as_mut().unwrap()[1] = 0x3001;
    let mut image = image(&[(0x3048, 0x000a000000201087, 8)]);
    assert_eq!(
        walk(&mut image, &state, request(0x41234567, Access::Read, true))
            .unwrap()
            .physical,
        0x000a000000234567
    );
    for (word, nxe, access, code) in [
        (0x000a000000203087, false, Access::Read, 0xd),
        (0x001a000000201087, false, Access::Read, 0xd),
        (0x800a000000201087, false, Access::Execute, 0xd),
        (0x800a000000201087, true, Access::Execute, 0x15),
    ] {
        image.physical_write(0x3048, 8, word).unwrap();
        state.efer = u64::from(nxe) << 11;
        assert_eq!(
            walk(&mut image, &state, request(0x41234567, access, true)),
            Err(pf(0x41234567, access, code))
        );
    }
}

#[test]
fn nonpae_fetch_never_sets_id_even_with_nxe() {
    let mut image = image(&[(0x1120, 0, 4)]);
    let state = State {
        efer: 0x800,
        ..legacy(false)
    };
    assert_eq!(
        walk(
            &mut image,
            &state,
            request(0x12345678, Access::Execute, true)
        ),
        Err(pf(0x12345678, Access::Execute, 4))
    );
}

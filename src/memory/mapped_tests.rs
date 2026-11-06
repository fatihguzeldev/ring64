use super::*;

fn limits() -> MemoryLimits {
    MemoryLimits {
        max_backing_bytes: 64,
        max_backings: 4,
        max_mappings: 8,
    }
}
fn mapping(base: u64, offset: u32, length: u32, mask: u8) -> MappingInput {
    MappingInput {
        base,
        backing: "bytes".into(),
        offset,
        length,
        permissions: Permissions {
            read: mask & 1 != 0,
            write: mask & 2 != 0,
            execute: mask & 4 != 0,
        },
    }
}
fn image(mappings: Vec<MappingInput>) -> Image {
    Image::mapped(
        vec![("bytes".into(), vec![0xb8, 1, 2, 3, 4, 5, 6, 7])],
        mappings,
        limits(),
    )
    .unwrap()
}

#[test]
fn permission_bits_are_independent_and_rmw_preflights_both_bits() {
    for mask in 0..8 {
        let mut image = image(vec![mapping(0x1000, 0, 8, mask)]);
        assert_eq!(image.fetch(0x1000).is_ok(), mask & 4 != 0);
        assert_eq!(image.read(0x1000, 1).is_ok(), mask & 1 != 0);
        assert_eq!(image.read_for_write(0x1000, 1).is_ok(), mask & 3 == 3);
        if mask & 3 != 3 {
            let fault = image.read_for_write(0x1000, 1).unwrap_err();
            assert_eq!(
                (fault.access, fault.cause, fault.failing),
                (Access::Write, Cause::Permission, 0x1000)
            );
        }
        assert_eq!(image.write(0x1000, 1, 0x77).is_ok(), mask & 2 != 0);
    }
}

#[test]
fn split_store_aliases_commit_in_guest_order_and_fail_before_every_byte() {
    let mut image = image(vec![mapping(0x1000, 0, 2, 3), mapping(0x1002, 0, 2, 3)]);
    image.write(0x1000, 4, 0x4433_2211).unwrap();
    assert_eq!(
        image.read_bytes(0x1000, 4).unwrap(),
        [0x33, 0x44, 0x33, 0x44]
    );
    image
        .set_mappings(vec![mapping(0x1000, 0, 2, 3), mapping(0x1002, 0, 2, 1)])
        .unwrap();
    assert_eq!(image.write(0x1000, 4, 0).unwrap_err().failing, 0x1002);
    assert_eq!(
        image.read_bytes(0x1000, 4).unwrap(),
        [0x33, 0x44, 0x33, 0x44]
    );
}

#[test]
fn source_validity_follows_backing_bytes_and_preserves_unrelated_writes() {
    let maps = vec![mapping(0x1000, 0, 8, 5), mapping(0x4000, 0, 8, 3)];
    let mut image = image(maps.clone());
    let owner = image.register_source([(0x1000, 3)]).unwrap();
    assert!(image.activate(owner));
    image.write(0x4007, 1, 0xaa).unwrap();
    assert!(image.owner_valid(owner));
    assert!(!image.active_changed());
    image
        .set_mappings(maps.into_iter().rev().collect())
        .unwrap();
    assert!(image.owner_valid(owner));
    image.write(0x4001, 1, 1).unwrap();
    assert!(!image.owner_valid(owner));
    assert!(image.active_changed());
    image.release(owner);
    assert!(!image.owner_valid(owner));
}

#[test]
fn remaps_and_backing_recreation_cannot_resurrect_an_owner() {
    let mut image = image(vec![mapping(0x1000, 0, 8, 5)]);
    let owner = image.register_source([(0x1000, 3)]).unwrap();
    image.set_mappings(vec![]).unwrap();
    assert!(!image.owner_valid(owner));
    image.remove_backing("bytes").unwrap();
    image
        .add_backing("bytes".into(), vec![0xb8, 1, 2, 3, 4, 5, 6, 7])
        .unwrap();
    image.set_mappings(vec![mapping(0x1000, 0, 8, 5)]).unwrap();
    assert!(!image.owner_valid(owner));
    let newer = image.register_source([(0x1000, 3)]).unwrap();
    assert_ne!(owner, newer);
    image.release(owner);
    assert!(image.owner_valid(newer));
}

#[test]
fn rejected_table_and_capacity_changes_are_atomic() {
    let mut image = image(vec![mapping(0x1000, 0, 8, 7)]);
    let owner = image.register_source([(0x1000, 3)]).unwrap();
    assert!(
        image
            .set_mappings(vec![mapping(0x1000, 0, 8, 7), mapping(0x1007, 0, 1, 7)])
            .is_err()
    );
    assert!(image.add_backing("large".into(), vec![0; 64]).is_err());
    assert!(image.remove_backing("bytes").is_err());
    assert!(image.owner_valid(owner));
    assert_eq!(image.read(0x1000, 1), Ok(0xb8));
}

#[test]
fn every_split_scalar_width_keeps_old_reads_and_ordered_alias_stores() {
    for width in [2u32, 4, 8] {
        for split in 1..width {
            let mut image = image(vec![
                mapping(0x1000, 0, split, 7),
                mapping(0x1000 + u64::from(split), 0, width - split, 7),
            ]);
            let original = [0xb8, 1, 2, 3, 4, 5, 6, 7];
            let old: Vec<_> = original[..split as usize]
                .iter()
                .chain(&original[..(width - split) as usize])
                .copied()
                .collect();
            let mut old_word = [0u8; 8];
            old_word[..width as usize].copy_from_slice(&old);
            assert_eq!(
                image.read_for_write(0x1000, width),
                Ok(u64::from_le_bytes(old_word))
            );
            let value = 0x8877_6655_4433_2211u64;
            let input = value.to_le_bytes();
            let mut expected = original;
            for (byte, &value) in input.iter().enumerate().take(width as usize) {
                let backing_offset = if byte < split as usize {
                    byte
                } else {
                    byte - split as usize
                };
                expected[backing_offset] = value;
            }
            image.write(0x1000, width, value).unwrap();
            assert_eq!(image.backings[0].bytes, expected);
        }
    }
}

#[test]
fn split_preflight_rejects_before_bytes_or_source_validity_can_change() {
    for width in [2u32, 4, 8] {
        for split in 1..width {
            for permissions in [1, 2] {
                let mut image = image(vec![
                    mapping(0x1000, 0, split, 7),
                    mapping(0x1000 + u64::from(split), split, width - split, permissions),
                ]);
                let owner = image.register_source([(0x1000, split)]).unwrap();
                image.activate(owner);
                let before = image.backings[0].bytes.clone();
                let fault = image.read_for_write(0x1000, width).unwrap_err();
                assert_eq!(
                    (fault.access, fault.cause, fault.failing),
                    (Access::Write, Cause::Permission, u128::from(0x1000 + split))
                );
                if permissions == 1 {
                    assert!(image.write(0x1000, width, 0).is_err());
                }
                assert_eq!(image.backings[0].bytes, before);
                assert!(image.owner_valid(owner));
                assert!(!image.active_changed());
            }
        }
    }
}

#[test]
fn a_final_address_source_can_be_patched_through_a_low_alias() {
    let mut image = image(vec![mapping(u64::MAX, 0, 1, 7), mapping(0x1000, 0, 1, 3)]);
    let owner = image.register_source([(u64::MAX, 1)]).unwrap();
    image.activate(owner);
    assert_eq!(image.fetch(u64::MAX), Ok(0xb8));
    assert_eq!(image.read(u64::MAX, 1), Ok(0xb8));
    image.write(0x1000, 1, 0xb9).unwrap();
    assert_eq!(image.fetch(u64::MAX), Ok(0xb9));
    assert!(image.active_changed());
    assert_eq!(
        image.write(u64::MAX, 2, 0).unwrap_err().cause,
        Cause::AddressRange
    );
    assert_eq!(image.read(u64::MAX, 1), Ok(0xb9));
}

#[test]
fn cached_mapping_still_checks_full_split_permissions_and_successful_remaps() {
    let mut image = image(vec![mapping(0x1000, 0, 2, 7), mapping(0x1002, 4, 2, 7)]);
    assert_eq!(image.read(0x1001, 1), Ok(1));
    assert_eq!(image.last_mapping.get(), 0);
    assert_eq!(image.read_for_write(0x1001, 2), Ok(0x0401));
    let cached = image.last_mapping.get();
    assert!(image.set_mappings(vec![mapping(0x1000, 7, 2, 7)]).is_err());
    assert_eq!(image.last_mapping.get(), cached);
    assert_eq!(image.read(0x1001, 2), Ok(0x0401));
    image
        .set_mappings(vec![mapping(0x1000, 0, 2, 7), mapping(0x1002, 4, 2, 1)])
        .unwrap();
    assert_eq!(image.last_mapping.get(), usize::MAX);
    assert_eq!(image.read(0x1001, 1), Ok(1));
    let before = image.backings[0].bytes.clone();
    let fault = image.read_for_write(0x1001, 2).unwrap_err();
    assert_eq!(
        (fault.access, fault.cause, fault.failing),
        (Access::Write, Cause::Permission, 0x1002)
    );
    assert_eq!(image.backings[0].bytes, before);
    image.set_mappings(vec![mapping(0x1000, 6, 2, 3)]).unwrap();
    assert_eq!(image.read(0x1000, 2), Ok(0x0706));
    assert_eq!(image.fetch(0x1000).unwrap_err().cause, Cause::Permission);
    image.set_mappings(vec![]).unwrap();
    assert_eq!(image.read(0x1000, 1).unwrap_err().cause, Cause::Unmapped);
}

#[test]
fn cached_mapping_never_bypasses_domain_checks_or_selects_a_nearby_span() {
    let mut image = image(vec![mapping(u64::MAX, 0, 1, 7), mapping(0x1000, 1, 1, 3)]);
    assert_eq!(image.read(u64::MAX, 1), Ok(0xb8));
    assert_eq!(
        image.read(u64::MAX, 2).unwrap_err().cause,
        Cause::AddressRange
    );
    assert_eq!(image.read(0x1000, 1), Ok(1));
    assert_eq!(image.read(0x1001, 1).unwrap_err().cause, Cause::Unmapped);
    image.write(0x1000, 1, 0x77).unwrap();
    assert_eq!(image.fetch(u64::MAX), Ok(0xb8));
    assert_eq!(
        image.read(0x8000_0000_0000, 1).unwrap_err().cause,
        Cause::Noncanonical
    );
}

#[test]
fn backing_watch_flags_follow_first_last_owner_and_backing_recreation() {
    let mut image = image(vec![mapping(0x1000, 0, 8, 7)]);
    assert!(!image.backings[0].has_sources);
    image.write(0x1000, 1, 0xb9).unwrap();
    let first = image.register_source([(0x1000, 2)]).unwrap();
    assert!(image.backings[0].has_sources);
    let second = image.register_source([(0x1002, 2)]).unwrap();
    image.release(first);
    assert!(image.backings[0].has_sources);
    image.release(second);
    assert!(!image.backings[0].has_sources);
    let third = image.register_source([(0x1000, 1)]).unwrap();
    image.activate(third);
    image.write(0x1000, 1, 0xba).unwrap();
    assert!(!image.owner_valid(third));
    assert!(image.active_changed());
    image.set_mappings(vec![]).unwrap();
    assert!(!image.backings[0].has_sources);
    image.remove_backing("bytes").unwrap();
    image.add_backing("bytes".into(), vec![0xb8; 8]).unwrap();
    assert!(!image.backings[0].has_sources);
    image.set_mappings(vec![mapping(0x1000, 0, 8, 7)]).unwrap();
    let replacement = image.register_source([(0x1000, 1)]).unwrap();
    assert!(image.backings[0].has_sources);
    image.activate(replacement);
    image.write(0x1000, 1, 0xbb).unwrap();
    assert!(!image.owner_valid(replacement));
    assert!(image.active_changed());
    image.release(third);
    assert!(!image.backings[0].has_sources);
    image.release(replacement);
    assert!(!image.backings[0].has_sources);
}

#[test]
fn two_checked_mapping_indices_cover_alternating_regions_and_table_changes() {
    let mut image = image(vec![
        mapping(0x1000, 0, 1, 3),
        mapping(0x2000, 1, 1, 3),
        mapping(0x3000, 2, 1, 3),
    ]);
    assert_eq!(image.read(0x1000, 1), Ok(0xb8));
    assert_eq!(image.read(0x2000, 1), Ok(1));
    for _ in 0..32 {
        assert_eq!(image.read_for_write(0x1000, 1), Ok(0xb8));
        assert_eq!(
            (image.last_mapping.get(), image.previous_mapping.get()),
            (0, 1)
        );
        assert_eq!(image.read_for_write(0x2000, 1), Ok(1));
        assert_eq!(
            (image.last_mapping.get(), image.previous_mapping.get()),
            (1, 0)
        );
    }
    let before = (image.last_mapping.get(), image.previous_mapping.get());
    assert!(image.set_mappings(vec![mapping(0x1000, 8, 1, 3)]).is_err());
    assert_eq!(
        (image.last_mapping.get(), image.previous_mapping.get()),
        before
    );
    assert_eq!(image.read(0x3000, 1), Ok(2));
    assert_eq!(
        (image.last_mapping.get(), image.previous_mapping.get()),
        (2, 1)
    );
    image
        .set_mappings(vec![mapping(0x1000, 3, 1, 1), mapping(0x2000, 4, 1, 3)])
        .unwrap();
    assert_eq!(
        (image.last_mapping.get(), image.previous_mapping.get()),
        (usize::MAX, usize::MAX)
    );
    assert_eq!(image.read(0x2000, 1), Ok(4));
    assert_eq!(image.read(0x1000, 1), Ok(3));
    assert_eq!(
        image.read_for_write(0x1000, 1).unwrap_err().cause,
        Cause::Permission
    );
    assert_eq!(image.read(0x3000, 1).unwrap_err().cause, Cause::Unmapped);
    image.set_mappings(vec![]).unwrap();
    assert_eq!(image.read(0x1000, 1).unwrap_err().cause, Cause::Unmapped);
    assert_eq!(image.read(0x2000, 1).unwrap_err().cause, Cause::Unmapped);
}

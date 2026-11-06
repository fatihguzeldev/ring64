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

use super::*;

const CODE: u64 = 0x0000_8000_0000_1000;

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

fn mappings(code: u8, metadata: u8) -> Vec<MappingInput> {
    vec![
        mapping(CODE, 0, 4, code),
        mapping(0x2000, 12, 8, metadata),
        mapping(0x3000, 8, 16, 3),
    ]
}

fn image(mappings: Vec<MappingInput>) -> Image {
    Image::physical_mapped(
        vec![("bytes".into(), vec![0x90; 32])],
        mappings,
        MemoryLimits {
            max_backing_bytes: 32,
            max_backings: 1,
            max_mappings: 8,
        },
    )
    .unwrap()
}

#[test]
fn one_owner_tracks_execute_only_code_and_read_only_metadata_through_offset_aliases() {
    let mut image = image(mappings(4, 1));
    let combined = image
        .register_dependencies([(CODE, 4)], [(0x2000, 8)])
        .unwrap();
    let code_only = image.register_source([(CODE, 4)]).unwrap();
    assert_eq!((combined, code_only), (1, 2));
    assert!(image.activate(combined));
    image.physical_write(0x3001, 1, 0xaa).unwrap();
    assert!(image.owner_valid(combined));
    assert!(!image.active_changed());
    image.physical_write(0x3005, 1, 0xbb).unwrap();
    assert!(!image.owner_valid(combined));
    assert!(image.owner_valid(code_only));
    assert!(image.active_changed());
}

#[test]
fn remapping_rechecks_each_dependency_permission_without_demanding_unused_bits() {
    for (code, metadata, valid) in [
        (4, 1, true),
        (5, 1, true),
        (4, 3, true),
        (4, 4, false),
        (1, 1, false),
    ] {
        let mut image = image(mappings(4, 5));
        let owner = image
            .register_dependencies([(CODE, 4)], [(0x2000, 8)])
            .unwrap();
        assert!(image.activate(owner));
        image.set_mappings(mappings(code, metadata)).unwrap();
        assert_eq!(
            image.owner_valid(owner),
            valid,
            "code{code} metadata{metadata}"
        );
        assert_eq!(image.active_changed(), !valid);
    }
}

#[test]
fn failed_dependency_registration_is_atomic_and_preserves_old_source_identity_sequence() {
    let mut image = image(mappings(4, 1));
    for (code, read) in [(0x2000, CODE), (CODE, CODE), (CODE, 0x4000)] {
        assert!(
            image
                .register_dependencies([(code, 1)], [(read, 1)])
                .is_err()
        );
    }
    let first = image.register_source([(CODE, 4)]).unwrap();
    assert_eq!(first, 1);
    assert!(image.activate(first));
    assert!(
        image
            .register_dependencies([(CODE, 4)], [(0x2000, 9)])
            .is_err()
    );
    assert!(image.owner_valid(first));
    assert!(!image.active_changed());
    assert_eq!(
        image
            .register_dependencies([(CODE, 4)], [(0x2000, 8)])
            .unwrap(),
        2
    );
}

#[test]
fn metadata_slices_keep_backing_offsets_through_split_remaps_and_cannot_resurrect() {
    let mut image = image(mappings(4, 1));
    let owner = image
        .register_dependencies([(CODE, 4)], [(0x2000, 8)])
        .unwrap();
    let mut split = vec![
        mapping(CODE, 0, 4, 4),
        mapping(0x2000, 12, 3, 1),
        mapping(0x2003, 15, 5, 1),
    ];
    image.set_mappings(split.clone()).unwrap();
    assert!(image.owner_valid(owner));
    split[2].offset = 16;
    image.set_mappings(split).unwrap();
    assert!(!image.owner_valid(owner));
    image.set_mappings(mappings(4, 1)).unwrap();
    assert!(!image.owner_valid(owner));
}

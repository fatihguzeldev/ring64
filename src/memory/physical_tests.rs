use super::*;

const END: u64 = 1 << 52;
const HOLE: u64 = 0x0000_8000_0000_0000;

fn mapping(base: u64, offset: u32, length: u32, permissions: Permissions) -> MappingInput {
    MappingInput {
        base,
        backing: "bytes".into(),
        offset,
        length,
        permissions,
    }
}

fn all() -> Permissions {
    Permissions {
        read: true,
        write: true,
        execute: true,
    }
}

fn physical(bytes: Vec<u8>, mappings: Vec<MappingInput>) -> Image {
    Image::physical_mapped(
        vec![("bytes".into(), bytes)],
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
fn physical_sparse_high_addresses_and_the_last_byte_are_not_linear_addresses() {
    let mut image = physical(
        (0..16).collect(),
        vec![
            mapping(HOLE, 0, 4, all()),
            mapping(1 << 51, 4, 4, all()),
            mapping(END - 8, 8, 8, all()),
        ],
    );
    assert_eq!(image.physical_fetch(HOLE + 1), Ok(1));
    assert_eq!(image.physical_read(1 << 51, 4), Ok(0x0706_0504));
    assert_eq!(image.physical_read(END - 8, 8), Ok(0x0f0e_0d0c_0b0a_0908));
    image.physical_write(END - 1, 1, 0xa5).unwrap();
    assert_eq!(image.physical_read_bytes(END - 2, 2), Ok(vec![14, 0xa5]));
    assert_eq!(image.read(HOLE, 1).unwrap_err().cause, Cause::Noncanonical);
    for (address, width) in [(END - 1, 2), (END, 1), (u64::MAX, 8)] {
        let fault = image.physical_read(address, width).unwrap_err();
        assert_eq!(
            (fault.address, fault.width, fault.cause),
            (address, width, Cause::AddressRange)
        );
        assert_eq!(fault.failing, u128::from(address.max(END)));
    }
}

#[test]
fn physical_mapping_replacement_rejects_domain_overflow_atomically() {
    let mut image = physical(vec![0x90; 8], vec![mapping(HOLE, 0, 8, all())]);
    for candidate in [
        mapping(END - 3, 0, 4, all()),
        mapping(END, 0, 1, all()),
        mapping(u64::MAX, 0, 2, all()),
    ] {
        assert!(image.set_mappings(vec![candidate]).is_err());
        assert_eq!(image.physical_fetch(HOLE), Ok(0x90));
    }
    image
        .set_mappings(vec![mapping(END - 8, 0, 8, all())])
        .unwrap();
    assert_eq!(image.physical_fetch(END - 1), Ok(0x90));
    assert!(
        Image::mapped(
            vec![("bytes".into(), vec![0; 8])],
            vec![mapping(HOLE, 0, 8, all())],
            MemoryLimits {
                max_backing_bytes: 8,
                max_backings: 1,
                max_mappings: 1
            },
        )
        .is_err()
    );
}

#[test]
fn physical_alias_writes_preserve_backing_offsets_and_source_invalidation() {
    let mut image = physical(
        (0..16).collect(),
        vec![mapping(HOLE, 3, 4, all()), mapping(0x1000, 2, 8, all())],
    );
    let owner = image.register_source([(HOLE, 4)]).unwrap();
    assert!(image.activate(owner));
    image.physical_write_bytes(0x1002, &[0xa1, 0xb2]).unwrap();
    assert_eq!(
        image.physical_read_bytes(HOLE, 4),
        Ok(vec![3, 0xa1, 0xb2, 6])
    );
    assert!(!image.owner_valid(owner));
    assert!(image.active_changed());
}

#[test]
fn physical_accesses_check_the_actual_private_permission_and_full_span_before_writing() {
    let mut image = physical(
        vec![1, 2, 3, 4],
        vec![
            mapping(HOLE, 0, 2, all()),
            mapping(
                HOLE + 2,
                2,
                2,
                Permissions {
                    read: true,
                    write: false,
                    execute: false,
                },
            ),
        ],
    );
    assert_eq!(image.physical_read(HOLE, 4), Ok(0x0403_0201));
    assert_eq!(image.physical_check_read(HOLE, 4), Ok(()));
    let fault = image.physical_write(HOLE, 4, 0xaaaa_bbbb).unwrap_err();
    assert_eq!(
        (fault.access, fault.cause, fault.failing),
        (Access::Write, Cause::Permission, u128::from(HOLE + 2))
    );
    assert_eq!(image.physical_read_bytes(HOLE, 4), Ok(vec![1, 2, 3, 4]));
    assert_eq!(image.physical_check_write(HOLE, 4), Err(fault));
    assert_eq!(
        image.physical_check_execute(HOLE, 4).unwrap_err().failing,
        u128::from(HOLE + 2)
    );
    assert_eq!(
        image.physical_fetch(HOLE + 2).unwrap_err().access,
        Access::Execute
    );
    assert_eq!(
        image.physical_read(HOLE + 4, 1).unwrap_err().cause,
        Cause::Unmapped
    );

    image
        .set_mappings(vec![mapping(
            HOLE,
            0,
            4,
            Permissions {
                read: false,
                write: true,
                execute: false,
            },
        )])
        .unwrap();
    image.physical_write(HOLE, 1, 0xcc).unwrap();
    assert_eq!(
        image.physical_read(HOLE, 1).unwrap_err().cause,
        Cause::Permission
    );
}

#[test]
fn physical_rmw_admission_keeps_the_first_combined_read_write_failure() {
    let mut image = physical(
        vec![1, 2, 3, 4],
        vec![
            mapping(
                HOLE,
                0,
                2,
                Permissions {
                    read: false,
                    write: true,
                    execute: false,
                },
            ),
            mapping(
                HOLE + 2,
                2,
                2,
                Permissions {
                    read: true,
                    write: false,
                    execute: false,
                },
            ),
        ],
    );
    assert_eq!(
        image.physical_check_write(HOLE, 4).unwrap_err().failing,
        u128::from(HOLE + 2)
    );
    let expected = Fault {
        address: HOLE,
        width: 4,
        access: Access::Write,
        cause: Cause::Permission,
        failing: u128::from(HOLE),
    };
    assert_eq!(
        image.physical_check_access(HOLE, 4, Access::Write, true),
        Err(expected)
    );
    assert_eq!(image.physical_read_for_write(HOLE, 4), Err(expected));
    image
        .set_mappings(vec![mapping(HOLE, 0, 4, all())])
        .unwrap();
    assert_eq!(image.physical_read_for_write(HOLE, 4), Ok(0x0403_0201));
    assert_eq!(image.physical_read_bytes(HOLE, 4), Ok(vec![1, 2, 3, 4]));
}

use super::*;

fn mapping(base: u64, offset: u32, length: u32, read: bool, write: bool) -> MappingInput {
    MappingInput {
        base,
        backing: "data".into(),
        offset,
        length,
        permissions: Permissions {
            read,
            write,
            execute: false,
        },
    }
}

fn image(mappings: Vec<MappingInput>) -> Image {
    Image::mapped(
        vec![("data".into(), (0..32).collect())],
        mappings,
        MemoryLimits {
            max_backing_bytes: 32,
            max_backings: 1,
            max_mappings: 2,
        },
    )
    .unwrap()
}

#[test]
fn fixed_vector_reads_cross_every_split_and_zero_only_unused_transport_bytes() {
    for width in [2, 4, 8, 16] {
        for split in 1..width {
            let image = image(vec![
                mapping(0x1000, 3, split, true, true),
                mapping(
                    0x1000 + u64::from(split),
                    3 + split,
                    width - split,
                    true,
                    true,
                ),
            ]);
            let mut expected = [0; 16];
            for (index, byte) in expected.iter_mut().enumerate().take(width as usize) {
                *byte = (index + 3) as u8;
            }
            assert_eq!(
                image.read_vector(0x1000, width).unwrap(),
                expected,
                "width{width} split{split}"
            );
        }
    }
    let image = image(vec![mapping(u64::MAX - 15, 3, 16, true, true)]);
    assert_eq!(
        image.read_vector(u64::MAX - 15, 16).unwrap(),
        std::array::from_fn(|index| (index + 3) as u8)
    );
}

#[test]
fn every_vector_fault_position_preflights_the_complete_span_before_any_store() {
    for failing in 0..16 {
        for read in [false, true] {
            for write in [false, true] {
                let mut mappings = Vec::new();
                if failing > 0 {
                    mappings.push(mapping(0x1000, 0, failing, true, true));
                }
                mappings.push(mapping(
                    0x1000 + u64::from(failing),
                    failing,
                    16 - failing,
                    read,
                    write,
                ));
                let mut image = image(mappings);
                match image.read_vector(0x1000, 16) {
                    Ok(actual) => {
                        assert!(read);
                        assert_eq!(actual, std::array::from_fn(|i| i as u8));
                    }
                    Err(fault) => {
                        assert!(!read);
                        assert_eq!(
                            (fault.width, fault.access, fault.cause, fault.failing),
                            (
                                16,
                                Access::Read,
                                Cause::Permission,
                                0x1000 + u128::from(failing)
                            )
                        );
                    }
                }
                match image.write_bytes(0x1000, &[0xa5; 16]) {
                    Ok(()) => assert!(write),
                    Err(fault) => {
                        assert!(!write);
                        assert_eq!(
                            (fault.width, fault.access, fault.cause, fault.failing),
                            (
                                16,
                                Access::Write,
                                Cause::Permission,
                                0x1000 + u128::from(failing)
                            )
                        );
                    }
                }
                image
                    .set_mappings(vec![mapping(0x1000, 0, 32, true, true)])
                    .unwrap();
                let expected: Vec<u8> = (0..32)
                    .map(|i| if write && i < 16 { 0xa5 } else { i })
                    .collect();
                assert_eq!(
                    image.read_bytes(0x1000, 32).unwrap(),
                    expected,
                    "failure{failing} read{read} write{write}"
                );
            }
        }
    }
}

#[test]
fn vector_alias_stores_commit_in_linear_order() {
    let mut image = image(vec![
        mapping(0x1000, 0, 8, true, true),
        mapping(0x1008, 0, 8, true, true),
    ]);
    image
        .write_bytes(0x1000, &std::array::from_fn::<_, 16, _>(|i| i as u8))
        .unwrap();
    assert_eq!(
        image.read_vector(0x1000, 16).unwrap(),
        std::array::from_fn(|i| (i % 8 + 8) as u8)
    );
    image
        .set_mappings(vec![mapping(0x1000, 0, 32, true, true)])
        .unwrap();
    assert_eq!(
        image.read_bytes(0x1008, 24).unwrap(),
        (8..32).collect::<Vec<u8>>()
    );
}

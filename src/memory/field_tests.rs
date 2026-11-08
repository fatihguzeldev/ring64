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

fn image(length: u32, mappings: Vec<MappingInput>) -> Image {
    Image::mapped(
        vec![("data".into(), (0..length).map(|n| n as u8).collect())],
        mappings,
        MemoryLimits {
            max_backing_bytes: length,
            max_backings: 1,
            max_mappings: 4,
        },
    )
    .unwrap()
}

#[test]
fn selected_writes_check_the_nominal_span_and_invalidate_only_actual_fields() {
    let fields = [(0, 2), (4, 2), (8, 2), (12, 14)];
    let bytes: Vec<u8> = (0xa0..0xbc).collect();
    for writable in 0..=28 {
        let mut mappings = Vec::new();
        if writable != 0 {
            mappings.push(mapping(0x1000, 5, writable, false, true));
        }
        if writable != 28 {
            mappings.push(mapping(
                0x1000 + u64::from(writable),
                5 + writable,
                28 - writable,
                false,
                false,
            ));
        }
        for (base, offset) in [(0x2000, 7), (0x3000, 9)] {
            let mut executable = mapping(base, offset, 2, false, false);
            executable.permissions.execute = true;
            mappings.push(executable);
        }
        let mut image = image(40, mappings);
        let padding = image.register_source([(0x2000, 2)]).unwrap();
        let field = image.register_source([(0x3000, 2)]).unwrap();
        assert!(image.activate(field));
        let mut expected = image.backings[0].bytes.clone();
        let result = image.write_fields(0x1000, 28, &fields, &bytes);
        if writable == 28 {
            assert_eq!(result, Ok(()));
            for byte in [0, 1, 4, 5, 8, 9].into_iter().chain(12..26) {
                expected[5 + byte] = bytes[byte];
            }
        } else {
            let fault = result.unwrap_err();
            assert_eq!(
                (fault.width, fault.access, fault.cause, fault.failing),
                (
                    28,
                    Access::Write,
                    Cause::Permission,
                    0x1000 + u128::from(writable)
                )
            );
        }
        assert_eq!(image.backings[0].bytes, expected, "writable{writable}");
        assert!(image.owner_valid(padding));
        assert_eq!(image.owner_valid(field), writable != 28);
        assert_eq!(image.active_changed(), writable == 28);
    }
}

#[test]
fn selected_reads_admit_the_whole_operand_before_touching_output() {
    let fields = [(0, 5), (6, 8), (24, 4), (32, 10), (160, 128)];
    for readable in [0, 5, 287, 288, 415, 416, 511, 512] {
        let mut mappings = Vec::new();
        if readable != 0 {
            mappings.push(mapping(0x1000, 7, readable, true, false));
        }
        if readable != 512 {
            mappings.push(mapping(
                0x1000 + u64::from(readable),
                7 + readable,
                512 - readable,
                false,
                true,
            ));
        }
        let image = image(528, mappings);
        let mut output = [0xa5; 512];
        let result = image.read_fields(0x1000, 512, &fields, &mut output);
        let mut expected = [0xa5; 512];
        if readable == 512 {
            assert_eq!(result, Ok(()));
            for &(offset, length) in &fields {
                for byte in offset..offset + length {
                    expected[byte as usize] = (7 + byte) as u8;
                }
            }
        } else {
            let fault = result.unwrap_err();
            assert_eq!(
                (fault.width, fault.access, fault.cause, fault.failing),
                (
                    512,
                    Access::Read,
                    Cause::Permission,
                    0x1000 + u128::from(readable)
                )
            );
        }
        assert_eq!(output, expected, "readable{readable}");
    }
}

#[test]
fn selected_fields_preserve_order_across_aliases_at_the_final_guest_byte() {
    let address = u64::MAX - 15;
    let fields = [(0, 2), (4, 3), (12, 4)];
    let bytes: Vec<u8> = (0xa0..0xb0).collect();
    for split in [1, 8, 15] {
        let mut image = image(
            32,
            vec![
                mapping(address, 3, split, false, true),
                mapping(address + u64::from(split), 7, 16 - split, false, true),
            ],
        );
        let mut expected = image.backings[0].bytes.clone();
        for byte in [0, 1, 4, 5, 6, 12, 13, 14, 15] {
            let offset = if byte < split as usize {
                3 + byte
            } else {
                7 + byte - split as usize
            };
            expected[offset] = bytes[byte];
        }
        assert_eq!(image.write_fields(address, 16, &fields, &bytes), Ok(()));
        assert_eq!(image.backings[0].bytes, expected);
        assert_eq!(
            image
                .write_fields(address + 1, 16, &fields, &bytes)
                .unwrap_err()
                .cause,
            Cause::AddressRange
        );
        assert_eq!(image.backings[0].bytes, expected);
    }
    let mut empty = image(1, vec![]);
    assert_eq!(empty.write_fields(0x8000_0000_0000, 0, &[], &[]), Ok(()));
    assert_eq!(empty.read_fields(u64::MAX, 0, &[], &mut []), Ok(()));
}

#[test]
fn selected_field_transfers_leave_warm_scalar_mapping_hints_unchanged() {
    let mut image = image(
        32,
        vec![
            mapping(0x1000, 0, 16, true, true),
            mapping(0x4000, 16, 1, true, true),
            mapping(0x5000, 17, 1, true, true),
        ],
    );
    image.read(0x4000, 1).unwrap();
    image.read(0x5000, 1).unwrap();
    let hints = (image.last_mapping.get(), image.previous_mapping.get());
    let mut output = [0; 16];
    image
        .read_fields(0x1000, 16, &[(4, 4)], &mut output)
        .unwrap();
    image
        .write_fields(0x1000, 16, &[(4, 4)], &[0xa5; 16])
        .unwrap();
    assert_eq!(
        (image.last_mapping.get(), image.previous_mapping.get()),
        hints
    );
    assert_eq!(&output[4..8], &[4, 5, 6, 7]);
    assert_eq!(&image.backings[0].bytes[4..8], &[0xa5; 4]);
}

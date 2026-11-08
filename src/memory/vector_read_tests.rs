use super::*;

fn mapping(base: u64, offset: u32, length: u32, read: bool) -> MappingInput {
    MappingInput {
        base,
        backing: "data".into(),
        offset,
        length,
        permissions: Permissions {
            read,
            write: true,
            execute: false,
        },
    }
}

fn image(mappings: Vec<MappingInput>) -> Image {
    Image::mapped(
        vec![("data".into(), (0x80..0xc0).collect())],
        mappings,
        MemoryLimits {
            max_backing_bytes: 64,
            max_backings: 1,
            max_mappings: 2,
        },
    )
    .unwrap()
}

#[test]
fn single_mapping_reads_keep_exact_width_padding_and_high_boundary_offsets() {
    for width in [2, 4, 8, 10, 16] {
        for leading in [0, 1, 7] {
            for base in [
                0x4000,
                0x1_0000_4000,
                u64::MAX - u64::from(width + leading) + 1,
            ] {
                let image = image(vec![mapping(base, 3, width + leading, true)]);
                let before = image.backings[0].bytes.clone();
                let hints = (image.last_mapping.get(), image.previous_mapping.get());
                let mut expected = [0; 16];
                for (i, byte) in expected.iter_mut().take(width as usize).enumerate() {
                    *byte = 0x83 + leading as u8 + i as u8;
                }
                assert_eq!(
                    image.read_vector(base + u64::from(leading), width),
                    Ok(expected),
                    "width{width} leading{leading} base{base:x}"
                );
                assert_eq!(image.backings[0].bytes, before);
                assert_eq!(
                    (image.last_mapping.get(), image.previous_mapping.get()),
                    hints
                );
            }
        }
    }
}

#[test]
fn every_narrow_read_split_preflights_permission_and_gap_before_copying() {
    for width in [2, 4, 8, 10, 16] {
        for split in 1..width {
            for (gap, cause) in [(0, Cause::Permission), (1, Cause::Unmapped)] {
                let address = 0x1_0000_4000;
                let image = image(vec![
                    mapping(address, 3, split, true),
                    mapping(
                        address + u64::from(split + gap),
                        19,
                        width - split,
                        gap != 0,
                    ),
                ]);
                let before = image.backings[0].bytes.clone();
                assert_eq!(
                    image.read_vector(address, width),
                    Err(Fault {
                        address,
                        width,
                        access: Access::Read,
                        cause,
                        failing: u128::from(address) + u128::from(split),
                    })
                );
                assert_eq!(image.backings[0].bytes, before);
            }
        }
    }
}

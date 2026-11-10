use super::{Access, Cause, Fault, Image};
use crate::memory::{MappingInput, MemoryLimits, Permissions};

fn oracle(
    image: &Image,
    address: u64,
    width: u32,
    access: Access,
    rmw: bool,
) -> Result<usize, Fault> {
    let failure = |cause, failing| Fault {
        address,
        width,
        access,
        cause,
        failing,
    };
    if width == 0 {
        return Ok(0);
    }
    let start = u128::from(address);
    let end = start + u128::from(width);
    if end > 1u128 << 64 {
        return Err(failure(Cause::AddressRange, 1u128 << 64));
    }
    let hole_start = start.max(0x0000_8000_0000_0000);
    let hole_end = end.min(0xffff_8000_0000_0000);
    if hole_start < hole_end {
        return Err(failure(Cause::Noncanonical, hole_start));
    }
    let required = match access {
        Access::Read => 1,
        Access::Write => 2 | u8::from(rmw),
        Access::Execute => 4,
    };
    let mut first = None;
    for point in start..end {
        let index = image
            .mappings
            .iter()
            .position(|mapping| {
                let base = u128::from(mapping.base);
                (base..base + u128::from(mapping.length)).contains(&point)
            })
            .ok_or_else(|| failure(Cause::Unmapped, point))?;
        first.get_or_insert(index);
        let permissions = image.mappings[index].permissions;
        let granted = u8::from(permissions.read)
            | (u8::from(permissions.write) << 1)
            | (u8::from(permissions.execute) << 2);
        if granted & required != required {
            return Err(failure(Cause::Permission, point));
        }
    }
    Ok(first.unwrap())
}

#[test]
fn preflight_matches_widened_byte_admission_across_fragments_permissions_and_address_edges() {
    for base in [
        0x1000,
        0x0000_7fff_ffff_fff0,
        0xffff_8000_0000_0000,
        u64::MAX - 15,
    ] {
        for gap in [0, 1] {
            for masks in [
                [7; 3],
                [0, 7, 7],
                [7, 1, 7],
                [7, 2, 7],
                [7, 3, 7],
                [7, 4, 7],
                [7, 7, 0],
            ] {
                let mappings = [(0, 3, 0), (3 + gap, 5, 3), (8 + gap, 8 - gap, 8)]
                    .into_iter()
                    .enumerate()
                    .map(|(index, (relative, length, offset))| MappingInput {
                        base: base + u64::from(relative),
                        backing: "data".into(),
                        offset,
                        length,
                        permissions: Permissions {
                            read: masks[index] & 1 != 0,
                            write: masks[index] & 2 != 0,
                            execute: masks[index] & 4 != 0,
                        },
                    })
                    .collect();
                let image = Image::mapped(
                    vec![("data".into(), vec![0xa5; 16])],
                    mappings,
                    MemoryLimits {
                        max_backings: 1,
                        max_mappings: 3,
                        max_backing_bytes: 16,
                    },
                )
                .unwrap();
                for delta in [-1i128, 0, 3, 4, 8, 9, 15, 16] {
                    let Ok(address) = u64::try_from(i128::from(base) + delta) else {
                        continue;
                    };
                    for width in [0, 1, 2, 4, 8, 10, 16, 17, u32::MAX] {
                        for access in [Access::Read, Access::Write, Access::Execute] {
                            for rmw in [false, true] {
                                let expected = oracle(&image, address, width, access, rmw);
                                for cache_scalar in [false, true] {
                                    image.last_mapping.set(2);
                                    image.previous_mapping.set(1);
                                    assert_eq!(
                                        image.preflight(address, width, access, rmw, cache_scalar),
                                        expected,
                                        "base{base:x} gap{gap} masks{masks:?} address{address:x} width{width} access{access:?} rmw{rmw} cache{cache_scalar}"
                                    );
                                    if !cache_scalar || width == 0 {
                                        assert_eq!(
                                            (
                                                image.last_mapping.get(),
                                                image.previous_mapping.get()
                                            ),
                                            (2, 1)
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                assert_eq!(image.backings[0].bytes, [0xa5; 16]);
                assert!(!image.active_changed());
            }
        }
    }
}

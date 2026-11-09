use super::tests::{context, flat, image, mapping, run};
use super::*;

fn system(
    address: u128,
    width: u32,
    access: Access,
    cause: Cause,
    failing: u128,
    phase: SystemPhase,
    selector: u16,
) -> Failure {
    Failure::SystemMemory(SystemMemoryFault {
        address,
        width,
        access,
        cause,
        failing_address: failing,
        phase,
        table: Table::Gdt,
        selector,
    })
}

#[test]
fn review_accessed_byte_alone_needs_write_and_late_denial_preserves_pointer_and_source_owner() {
    for (access, writable) in [(0xf2u8, false), (0xf2, true), (0xf3, false)] {
        let mut c = context("long64", 3);
        c.set_gdtr(TableRegister {
            base: 0x4ff8,
            limit: 15,
        });
        let mut bytes = [0xa5; 24];
        bytes[..8]
            .copy_from_slice(&(0x1242_0034_5678_3456u64 | (u64::from(access) << 40)).to_le_bytes());
        bytes[8..18].copy_from_slice(&[0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xfe, 0x0b, 0]);
        let mut m = image(
            bytes.to_vec(),
            vec![
                mapping(0x5000, 0, 5, true, false),
                mapping(0x5005, 5, 1, true, writable),
                mapping(0x5006, 6, 2, true, false),
                mapping(0x6000, 8, 10, true, false),
            ],
        );
        let owner = m.register_source([(0x5000, 8), (0x6000, 10)]).unwrap();
        assert!(m.activate(owner));
        let before = c.clone();
        let result = run(
            &mut c,
            &mut m,
            ProtectionKind::LoadFar(Segment::Fs),
            Width::W64,
            true,
            0x6000,
            0,
        );
        if access == 0xf2 && !writable {
            assert_eq!(
                result,
                Err(system(
                    0x5005,
                    1,
                    Access::Write,
                    Cause::Permission,
                    0x5005,
                    SystemPhase::AccessedWrite,
                    11
                ))
            );
            assert_eq!(c, before);
            assert_eq!(m.read_bytes(0x5000, 8).unwrap(), bytes[..8]);
            assert!(m.owner_valid(owner));
            assert!(!m.active_changed());
        } else {
            assert_eq!(result.unwrap().value, Some(0xfedd_ccbb_aa99_8877));
            assert_eq!(c.selector(Segment::Fs), 11);
            assert_eq!(c.segment(Segment::Fs).base, 0x1234_5678);
            assert_eq!(c.segment(Segment::Fs).limit, 0x23456);
            assert!(c.attributes(Segment::Fs).accessed);
            let mut expected = bytes[..8].to_vec();
            expected[5] |= 1;
            assert_eq!(m.read_bytes(0x5000, 8).unwrap(), expected);
            assert_eq!(m.owner_valid(owner), access == 0xf3);
            assert_eq!(m.active_changed(), access == 0xf2);
        }
        assert_eq!(m.read_bytes(0x6000, 10).unwrap(), bytes[8..18]);
    }
}

#[test]
fn review_accessed_alias_changes_live_descriptor_memory_but_installs_the_captured_limit() {
    let mut c = context("long64", 3);
    c.set_gdtr(TableRegister {
        base: 0x4ff8,
        limit: 15,
    });
    // Descriptor byte5 aliases byte0: setting A also changes the limit in memory.
    let mut m = image(
        vec![0xf2, 0x56, 0x34, 0x12, 0xab],
        vec![
            mapping(0x5000, 0, 5, true, false),
            mapping(0x5005, 0, 1, true, true),
            mapping(0x5006, 1, 2, true, false),
        ],
    );
    assert_eq!(
        m.read_bytes(0x5000, 8).unwrap(),
        [0xf2, 0x56, 0x34, 0x12, 0xab, 0xf2, 0x56, 0x34]
    );
    let owner = m.register_source([(0x5000, 1)]).unwrap();
    assert!(m.activate(owner));
    run(
        &mut c,
        &mut m,
        ProtectionKind::LoadSegment(Segment::Gs),
        Width::W16,
        false,
        0,
        11,
    )
    .unwrap();
    assert_eq!(
        m.read_bytes(0x5000, 8).unwrap(),
        [0xf3, 0x56, 0x34, 0x12, 0xab, 0xf3, 0x56, 0x34]
    );
    assert_eq!(c.segment(Segment::Gs).base, 0x34ab_1234);
    assert_eq!(c.segment(Segment::Gs).limit, 0x656f2);
    assert!(c.attributes(Segment::Gs).accessed);
    assert!(!m.owner_valid(owner));
    assert!(m.active_changed());
}

#[test]
fn review_widened_system_starts_and_split_upper_reads_keep_exact_overflow_provenance() {
    let end = 1u128 << 64;
    for (base, address, cause, failing) in [
        (u64::MAX - 3, end + 4, Cause::AddressRange, end + 4),
        (u64::MAX - 7, end, Cause::AddressRange, end),
        (u64::MAX - 11, end - 4, Cause::AddressRange, end),
        (
            0x7fff_ffff_fff4,
            0x7fff_ffff_fffc,
            Cause::Noncanonical,
            0x8000_0000_0000,
        ),
        (
            0x7fff_ffff_fff8,
            0x8000_0000_0000,
            Cause::Noncanonical,
            0x8000_0000_0000,
        ),
    ] {
        let mut c = context("long64", 0);
        c.set_gdtr(TableRegister { base, limit: 15 });
        let before = c.clone();
        let mut m = flat();
        assert_eq!(
            run(
                &mut c,
                &mut m,
                ProtectionKind::Lar,
                Width::W64,
                false,
                0,
                11
            ),
            Err(system(
                address,
                8,
                Access::Read,
                cause,
                failing,
                SystemPhase::DescriptorRead,
                11
            ))
        );
        assert_eq!(c, before);
    }
    for (raw, vector) in [
        (0x0000_8200_0000_1234u64, None),
        (0x0000_9200_0000_1234, Some(13)),
        (0x0000_0200_0000_1234, Some(11)),
    ] {
        let mut c = context("long64", 0);
        c.set_gdtr(TableRegister {
            base: u64::MAX - 15,
            limit: 23,
        });
        let before = c.clone();
        let mut m = image(
            raw.to_le_bytes().to_vec(),
            vec![mapping(u64::MAX - 7, 0, 8, true, false)],
        );
        let result = run(
            &mut c,
            &mut m,
            ProtectionKind::LoadLdt,
            Width::W16,
            false,
            0,
            8,
        );
        let expected = if let Some(vector) = vector {
            Failure::Protection(ProtectionFault {
                vector,
                error_code: 8,
                phase: ProtectionPhase::Descriptor,
                selector: Some(8),
            })
        } else {
            system(
                end,
                8,
                Access::Read,
                Cause::AddressRange,
                end,
                SystemPhase::DescriptorRead,
                8,
            )
        };
        assert_eq!(result, Err(expected));
        assert_eq!(c, before);
    }
}

#[test]
fn review_lsl_required_low_read_precedes_tail_extent_but_rejected_low_types_never_probe_tail() {
    let mut c = context("long64", 0);
    c.set_gdtr(TableRegister {
        base: 0x4000,
        limit: 15,
    });
    let before = c.clone();
    let mut m = flat();
    assert_eq!(
        run(&mut c, &mut m, ProtectionKind::Lsl, Width::W64, false, 0, 8),
        Err(system(
            0x4008,
            8,
            Access::Read,
            Cause::Unmapped,
            0x4008,
            SystemPhase::DescriptorRead,
            8
        ))
    );
    assert_eq!(c, before);
    for (access, succeeds_without_tail) in
        [(0x02u8, false), (0x0c, true), (0x10, true), (0x80, true)]
    {
        let raw = 0x0000_0000_0000_1234u64 | (u64::from(access) << 40);
        m = image(
            raw.to_le_bytes().to_vec(),
            vec![mapping(0x4008, 0, 8, true, false)],
        );
        let short = run(&mut c, &mut m, ProtectionKind::Lsl, Width::W64, false, 0, 8).unwrap();
        assert_eq!(short.zero, Some(access == 0x10));
        c.set_gdtr(TableRegister {
            base: 0x4000,
            limit: 23,
        });
        let result = run(&mut c, &mut m, ProtectionKind::Lsl, Width::W64, false, 0, 8);
        if succeeds_without_tail {
            assert_eq!(result.unwrap().zero, Some(access == 0x10));
        } else {
            assert_eq!(
                result,
                Err(system(
                    0x4010,
                    8,
                    Access::Read,
                    Cause::Unmapped,
                    0x4010,
                    SystemPhase::DescriptorRead,
                    8
                ))
            );
        }
        if access == 0x02 {
            assert_eq!(
                run(&mut c, &mut m, ProtectionKind::Lar, Width::W64, false, 0, 8)
                    .unwrap()
                    .value,
                Some(0x0200)
            );
            assert_eq!(
                run(
                    &mut c,
                    &mut m,
                    ProtectionKind::LoadLdt,
                    Width::W16,
                    false,
                    0,
                    8
                ),
                Err(Failure::Protection(ProtectionFault {
                    vector: 11,
                    error_code: 8,
                    phase: ProtectionPhase::Descriptor,
                    selector: Some(8),
                }))
            );
        }
        c.set_gdtr(TableRegister {
            base: 0x4000,
            limit: 15,
        });
    }
}

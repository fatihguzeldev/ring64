use super::tests::{context, flat, image, mapping, run};
use super::*;
use crate::x86::context::{LdtRegister, SegmentType};

#[test]
fn legacy_ldt_entry_zero_and_loaded_ldtr_survive_descriptor_edits_until_reload() {
    let mut context = context("protected", 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
    let mut image = flat();
    image.write(0x1008, 8, 0x0000_8200_1080_0017).unwrap();
    image.write(0x1080, 8, 0x0000_9300_2200_00ff).unwrap();
    assert!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadLdt,
            Width::W16,
            false,
            0,
            0xffff_000b
        )
        .unwrap()
        .context_changed
    );
    assert_eq!(
        context.ldtr(),
        LdtRegister {
            selector: 11,
            valid: true,
            base: 0x1080,
            limit: 0x17,
            attributes: 0x82
        }
    );
    assert!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadSegment(Segment::Ds),
            Width::W16,
            false,
            0,
            4
        )
        .unwrap()
        .context_changed
    );
    assert_eq!(context.selector(Segment::Ds), 4);
    assert_eq!(context.segment(Segment::Ds).base, 0x2200);
    image.write(0x1008, 8, 0x0000_8200_10a0_0017).unwrap();
    assert!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadSegment(Segment::Fs),
            Width::W16,
            false,
            0,
            4
        )
        .unwrap()
        .context_changed
    );
    assert_eq!(context.segment(Segment::Fs).base, 0x2200);
    run(
        &mut context,
        &mut image,
        ProtectionKind::LoadLdt,
        Width::W16,
        false,
        0,
        11,
    )
    .unwrap();
    let before = context.clone();
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadSegment(Segment::Fs),
            Width::W16,
            false,
            0,
            4
        ),
        Err(Failure::Protection(ProtectionFault {
            vector: 13,
            error_code: 4,
            phase: ProtectionPhase::Descriptor,
            selector: Some(4),
        }))
    );
    assert_eq!(context, before);
    assert_eq!(context.segment(Segment::Ds).base, 0x2200);
}

#[test]
fn extended_ldtr_keeps_ignored_high_bits_but_rejects_type_and_noncanonical_base_atomically() {
    for mode in ["compatibility", "long64"] {
        let mut context = context(mode, 0);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 23,
        });
        let mut image = flat();
        image.write(0x1008, 8, 0x0000_8200_1080_0017).unwrap();
        image.write(0x1010, 8, 0xffff_e0ff_0000_0001).unwrap();
        assert!(
            run(
                &mut context,
                &mut image,
                ProtectionKind::LoadLdt,
                Width::W16,
                false,
                0,
                11
            )
            .unwrap()
            .context_changed
        );
        assert_eq!(
            context.ldtr(),
            LdtRegister {
                selector: 11,
                valid: true,
                base: 0x1_0000_1080,
                limit: 0x17,
                attributes: 0x82
            }
        );
        for invalid_upper in [0xffff_f0ff_0000_0001, 0xffff_e0ff_0000_8000] {
            image.write(0x1010, 8, invalid_upper).unwrap();
            let before = context.clone();
            assert_eq!(
                run(
                    &mut context,
                    &mut image,
                    ProtectionKind::LoadLdt,
                    Width::W16,
                    false,
                    0,
                    11
                ),
                Err(Failure::Protection(ProtectionFault {
                    vector: 13,
                    error_code: 8,
                    phase: ProtectionPhase::Descriptor,
                    selector: Some(11),
                }))
            );
            assert_eq!(context, before);
        }
    }
}

#[test]
fn ldtr_type_presence_and_extent_checks_do_not_speculatively_read_upper_half() {
    let mut context = context("long64", 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 23,
    });
    let mut image = image(vec![0; 8], vec![mapping(0x1008, 0, 8, true, true)]);
    for (raw, vector) in [(0x0000_9200_0000_ffff, 13), (0x0000_0200_0000_ffff, 11)] {
        image.write(0x1008, 8, raw).unwrap();
        let before = context.clone();
        assert_eq!(
            run(
                &mut context,
                &mut image,
                ProtectionKind::LoadLdt,
                Width::W16,
                false,
                0,
                8
            ),
            Err(Failure::Protection(ProtectionFault {
                vector,
                error_code: 8,
                phase: ProtectionPhase::Descriptor,
                selector: Some(8),
            }))
        );
        assert_eq!(context, before);
    }
    context.set_gdtr(TableRegister {
        base: 0x5000,
        limit: 15,
    });
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadLdt,
            Width::W16,
            false,
            0,
            11
        ),
        Err(Failure::Protection(ProtectionFault {
            vector: 13,
            error_code: 8,
            phase: ProtectionPhase::Selector,
            selector: Some(11),
        }))
    );
    for null in 0..4 {
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadLdt,
            Width::W16,
            false,
            0,
            null,
        )
        .unwrap();
        assert_eq!(
            context.ldtr(),
            LdtRegister {
                selector: null as u16,
                ..LdtRegister::default()
            }
        );
    }
}

#[test]
fn data_load_checks_type_and_privilege_before_presence_and_sets_cached_accessed() {
    let cases = [
        (3, 11, 0x92, Some(13)),
        (0, 11, 0x92, Some(13)),
        (3, 11, 0xf2, None),
        (0, 8, 0x90, None),
        (3, 11, 0x9e, None),
        (3, 11, 0x1e, Some(11)),
        (0, 8, 0x98, Some(13)),
        (0, 8, 0x18, Some(13)),
        (0, 8, 0x82, Some(13)),
    ];
    for (cpl, selector, access, vector) in cases {
        let mut context = context("protected", cpl);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 15,
        });
        let mut image = flat();
        let raw = 0x0000_0000_2200_00ff | (access as u64) << 40;
        image.write(0x1008, 8, raw).unwrap();
        let before = context.clone();
        let result = run(
            &mut context,
            &mut image,
            ProtectionKind::LoadSegment(Segment::Ds),
            Width::W16,
            false,
            0,
            selector,
        );
        if let Some(vector) = vector {
            assert_eq!(
                result,
                Err(Failure::Protection(ProtectionFault {
                    vector,
                    error_code: (selector as u16) & 0xfffc,
                    phase: ProtectionPhase::Descriptor,
                    selector: Some(selector as u16)
                }))
            );
            assert_eq!(context, before);
            assert_eq!(image.read(0x1008, 8).unwrap(), raw);
        } else {
            assert!(result.unwrap().context_changed);
            assert_eq!(context.selector(Segment::Ds), selector as u16);
            assert_eq!(context.segment(Segment::Ds).base, 0x2200);
            assert!(context.attributes(Segment::Ds).accessed);
            assert_eq!(image.read(0x100d, 1).unwrap(), access as u64 | 1);
        }
    }
}

#[test]
fn far_source_is_captured_before_aliasing_accessed_write_invalidates_a_source_owner() {
    let mut context = context("protected", 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
    let mut bytes = vec![0; 32];
    bytes[8..16].copy_from_slice(&0x0000_9200_2200_00ffu64.to_le_bytes());
    bytes[16..19].copy_from_slice(&[0x44, 8, 0]);
    let mut image = image(
        bytes,
        vec![
            mapping(0x1008, 8, 8, true, true),
            mapping(0x1080, 13, 6, true, false),
        ],
    );
    let owner = image.register_source([(0x1080, 1)]).unwrap();
    assert!(image.activate(owner));
    let result = run(
        &mut context,
        &mut image,
        ProtectionKind::LoadFar(Segment::Ds),
        Width::W32,
        true,
        0x1080,
        0,
    )
    .unwrap();
    assert_eq!(result.value, Some(0x4400_0092));
    assert!(result.context_changed);
    assert_eq!(context.segment(Segment::Ds).base, 0x2200);
    assert!(context.attributes(Segment::Ds).accessed);
    assert_eq!(image.read(0x1080, 4).unwrap(), 0x4400_0093);
    assert!(!image.owner_valid(owner));
    assert!(image.active_changed());
}

#[test]
fn long_null_stack_rules_follow_cpl_and_do_not_validate_loaded_gpr_as_a_pointer() {
    for cpl in 0..4 {
        for selector in 0..4u16 {
            let mut context = context("long64", cpl);
            let old = context.clone();
            let mut image = flat();
            image
                .write_bytes(0x1000, &[0, 0, 0, 0, 0, 0x80, 0, 0, selector as u8, 0])
                .unwrap();
            let result = run(
                &mut context,
                &mut image,
                ProtectionKind::LoadFar(Segment::Ss),
                Width::W64,
                true,
                0x1000,
                0,
            );
            if cpl != 3 && selector == u16::from(cpl) {
                assert_eq!(result.unwrap().value, Some(0x0000_8000_0000_0000));
                assert_eq!(context.selector(Segment::Ss), selector);
                let cache = context.segment(Segment::Ss);
                assert!(!cache.usable);
                assert_eq!(cache.base, 0);
                assert_eq!(cache.limit, 0);
                assert_eq!(cache.kind, SegmentType::ReadOnly);
            } else {
                assert_eq!(
                    result,
                    Err(Failure::Protection(ProtectionFault {
                        vector: 13,
                        error_code: 0,
                        phase: ProtectionPhase::Selector,
                        selector: Some(selector)
                    }))
                );
                assert_eq!(context, old);
            }
        }
    }
}

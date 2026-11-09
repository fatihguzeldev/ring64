use super::tests::{context, flat, image, mapping, run};
use super::*;
use crate::x86::context::{LdtRegister, SegmentType};

#[test]
fn compatibility_queries_use_full_system_roots_above_four_gibibytes() {
    let mut context = context("compatibility", 0);
    let mut bytes = vec![0; 32];
    bytes[..8].copy_from_slice(&0x12ca_9a34_0000_3456u64.to_le_bytes());
    bytes[8..16].copy_from_slice(&0x0000_9300_0000_ffffu64.to_le_bytes());
    let mut image = image(
        bytes,
        vec![
            mapping(0x1_0000_0008, 0, 8, true, false),
            mapping(8, 8, 8, true, false),
        ],
    );
    context.set_gdtr(TableRegister {
        base: 0x1_0000_0000,
        limit: 15,
    });
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::Lar,
            Width::W32,
            false,
            0,
            8
        )
        .unwrap()
        .value,
        Some(0xc09a00)
    );
    context.set_ldtr(LdtRegister {
        selector: 8,
        valid: true,
        base: 0x1_0000_0008,
        limit: 7,
        attributes: 0x82,
    });
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::Lsl,
            Width::W32,
            false,
            0,
            4
        )
        .unwrap()
        .value,
        Some(0xa3456fff)
    );
}

#[test]
fn legacy_system_start_wraps_but_an_attempted_descriptor_span_does_not() {
    let mut context = context("protected", 0);
    context.set_gdtr(TableRegister {
        base: 0xffff_fff8,
        limit: 15,
    });
    let mut image = image(
        0x0000_9300_0000_ffffu64.to_le_bytes().to_vec(),
        vec![mapping(0, 0, 8, true, false)],
    );
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::Lar,
            Width::W32,
            false,
            0,
            8
        )
        .unwrap()
        .value,
        Some(0x9300)
    );
    context.set_gdtr(TableRegister {
        base: 0xffff_fff4,
        limit: 15,
    });
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::Lar,
            Width::W32,
            false,
            0,
            8
        ),
        Err(Failure::SystemMemory(SystemMemoryFault {
            address: 0xffff_fffc,
            width: 8,
            access: Access::Read,
            cause: Cause::AddressRange,
            failing_address: 0x1_0000_0000,
            phase: SystemPhase::DescriptorRead,
            table: Table::Gdt,
            reference: SystemReference::Selector(8),
        }))
    );
}

#[test]
fn real_reload_preserves_unreal_cache_attributes_while_virtual8086_keeps_normal_caches() {
    for mode in ["real", "virtual8086"] {
        let mut context = context(mode, if mode == "real" { 0 } else { 3 });
        if mode == "real" {
            let mut cache = context.segment(Segment::Fs);
            cache.limit = 0x1234_5678;
            cache.default32 = true;
            cache.kind = SegmentType::ExpandDownReadOnly;
            cache.usable = false;
            let attrs = context.attributes(Segment::Fs);
            context.set_segment(Segment::Fs, 0, cache, attrs);
        }
        let old = context.segment(Segment::Fs);
        let attributes = context.attributes(Segment::Fs);
        context.set_gdtr(TableRegister {
            base: 0x5000,
            limit: 0xffff,
        });
        let mut image = flat();
        for selector in [0, 0xf123] {
            run(
                &mut context,
                &mut image,
                ProtectionKind::LoadSegment(Segment::Fs),
                Width::W16,
                false,
                0,
                selector,
            )
            .unwrap();
            let mut expected = old;
            expected.base = selector << 4;
            assert_eq!(context.segment(Segment::Fs), expected);
            assert_eq!(context.attributes(Segment::Fs), attributes);
            assert_eq!(context.selector(Segment::Fs), selector as u16);
            assert_eq!(
                ExecutionContext::from_json(&context.to_json()).unwrap(),
                context
            );
        }
    }
}

#[test]
fn far_load_reads_through_old_fs_base_before_replacing_its_full_width() {
    let mut context = context("long64", 0);
    let mut old = context.segment(Segment::Fs);
    old.base = 0x1_0000_2000;
    let attributes = context.attributes(Segment::Fs);
    context.set_segment(Segment::Fs, 0x18, old, attributes);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
    let mut bytes = vec![0; 48];
    bytes[8..16].copy_from_slice(&0x1240_9334_5678_00ffu64.to_le_bytes());
    bytes[32..38].copy_from_slice(&[0x44, 0x33, 0x22, 0x11, 8, 0]);
    let mut image = image(
        bytes,
        vec![
            mapping(0x1008, 8, 8, true, false),
            mapping(0x1_0000_2100, 32, 6, true, false),
        ],
    );
    let result = execute(
        &mut context,
        &mut image,
        ProtectionDescriptor {
            kind: ProtectionKind::LoadFar(Segment::Fs),
            width: Width::W32,
            memory: true,
        },
        0x100,
        0,
        Segment::Fs,
    )
    .unwrap();
    assert_eq!(result.value, Some(0x1122_3344));
    assert_eq!(context.segment(Segment::Fs).base, 0x1234_5678);
    assert_eq!(context.selector(Segment::Fs), 8);
}

#[test]
fn lss_source_uses_old_stack_segment_and_publishes_encoded_offset_without_pointer_check() {
    let mut context = context("protected", 0);
    let mut old = context.segment(Segment::Ss);
    old.base = 0x2000;
    old.limit = 0xffff;
    old.default32 = false;
    let attrs = context.attributes(Segment::Ss);
    context.set_segment(Segment::Ss, 0x10, old, attrs);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
    let mut bytes = vec![0; 48];
    bytes[8..16].copy_from_slice(&0x0040_9300_3000_00ffu64.to_le_bytes());
    bytes[32..38].copy_from_slice(&[0x40, 0x30, 0x20, 0x10, 8, 0]);
    let mut image = image(
        bytes,
        vec![
            mapping(0x1008, 8, 8, true, false),
            mapping(0x2100, 32, 6, true, false),
        ],
    );
    assert_eq!(
        execute(
            &mut context,
            &mut image,
            ProtectionDescriptor {
                kind: ProtectionKind::LoadFar(Segment::Ss),
                width: Width::W32,
                memory: true
            },
            0x100,
            0,
            Segment::Ss
        )
        .unwrap()
        .value,
        Some(0x1020_3040)
    );
    assert_eq!(context.segment(Segment::Ss).base, 0x3000);
    assert!(context.segment(Segment::Ss).default32);
}

#[test]
fn explicit_far_pointer_last_byte_fault_precedes_any_descriptor_lookup_and_publication() {
    let mut context = context("long64", 0);
    context.set_gdtr(TableRegister {
        base: 0x5000,
        limit: 15,
    });
    let old = context.clone();
    let mut image = image(
        vec![0x44, 0x33, 0x22, 0x11, 8],
        vec![mapping(0x1000, 0, 5, true, false)],
    );
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadFar(Segment::Fs),
            Width::W32,
            true,
            0x1000,
            0
        ),
        Err(Failure::Operand(AccessFailure::Linear(
            crate::memory::Fault {
                address: 0x1000,
                width: 6,
                access: Access::Read,
                cause: Cause::Unmapped,
                failing: 0x1005,
            }
        )))
    );
    assert_eq!(context, old);
}

#[test]
fn segment_readback_memory_is_exact_write_only_m16_and_null_reload_roundtrips() {
    let mut context = context("protected", 0);
    let cache = context.segment(Segment::Fs);
    let attrs = context.attributes(Segment::Fs);
    context.set_segment(Segment::Fs, 0xabcd, cache, attrs);
    let mut image = image(vec![0xa5; 4], vec![mapping(0x1000, 1, 2, false, true)]);
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::ReadSegment(Segment::Fs),
            Width::W16,
            true,
            0x1000,
            0
        )
        .unwrap(),
        Outcome::default()
    );
    image
        .set_mappings(vec![mapping(0x2000, 0, 4, true, false)])
        .unwrap();
    assert_eq!(
        image.read_bytes(0x2000, 4).unwrap(),
        [0xa5, 0xcd, 0xab, 0xa5]
    );
    let mut image = flat();
    image.write(0x1000, 2, 3).unwrap();
    context.set_gdtr(TableRegister {
        base: 0x5000,
        limit: 0xffff,
    });
    run(
        &mut context,
        &mut image,
        ProtectionKind::LoadSegment(Segment::Fs),
        Width::W16,
        true,
        0x1000,
        0x8888,
    )
    .unwrap();
    assert_eq!(context.selector(Segment::Fs), 3);
    assert!(!context.segment(Segment::Fs).usable);
    assert_eq!(
        ExecutionContext::from_json(&context.to_json()).unwrap(),
        context
    );
}

#[test]
fn lsl_system_query_does_not_inherit_loaded_base_canonicality_or_presence_checks() {
    let mut context = context("long64", 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 23,
    });
    let mut image = flat();
    image.write(0x1008, 8, 0x0000_0200_0000_1234).unwrap();
    image.write(0x1010, 8, 0xffff_e0ff_0000_8000).unwrap();
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::Lsl,
            Width::W64,
            false,
            0,
            8
        )
        .unwrap(),
        Outcome {
            value: Some(0x1234),
            zero: Some(true),
            context_changed: false
        }
    );
}

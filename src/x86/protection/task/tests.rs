use super::*;
use crate::x86::protection::tests::{context, image, mapping};

fn configured(mode: &str) -> ExecutionContext {
    let mut context = context(mode, 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 0x2f,
    });
    context
}

fn descriptor(low: u64, high: u64) -> Vec<u8> {
    let mut bytes = vec![0xa5; 48];
    bytes[8..16].copy_from_slice(&low.to_le_bytes());
    bytes[16..24].copy_from_slice(&high.to_le_bytes());
    bytes
}

#[test]
fn ltr_captures_busy_cache_without_accessing_tss_body() {
    for (mode, access, expected) in [
        ("protected", 0x81u64, 0x83),
        ("protected", 0x89, 0x8b),
        ("long64", 0x89, 0x8b),
    ] {
        let mut context = configured(mode);
        let high = if mode == "long64" { 0xffff_8000 } else { 0 };
        let low = 0x1200_0034_5000_0067 | access << 40;
        let mut image = image(
            descriptor(low, high),
            vec![mapping(0x1000, 0, 48, true, true)],
        );
        assert!(load(&mut context, &mut image, 8).unwrap());
        assert_eq!(
            context.tr(),
            TaskRegister {
                selector: 8,
                valid: true,
                base: if mode == "long64" {
                    0xffff_8000_1234_5000
                } else {
                    0x1234_5000
                },
                limit: 0x67,
                attributes: expected,
            }
        );
        assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], expected as u8);
        assert!(load(&mut context, &mut image, 8).is_err());
    }
}

#[test]
fn ltr_rejects_null_ti_and_low_type_or_presence_before_high_tail_read() {
    for (selector, low, vector, phase) in [
        (0, 0x1200_8934_5000_0067, 13, ProtectionPhase::Selector),
        (12, 0x1200_8934_5000_0067, 13, ProtectionPhase::Selector),
        (8, 0x1200_8b34_5000_0067, 13, ProtectionPhase::Descriptor),
        (8, 0x1200_0934_5000_0067, 11, ProtectionPhase::Descriptor),
        (8, 0x1200_8134_5000_0067, 13, ProtectionPhase::Descriptor),
    ] {
        let mut context = configured("long64");
        let before = context.clone();
        let mut image = image(descriptor(low, 0), vec![mapping(0x1000, 0, 16, true, true)]);
        assert_eq!(
            load(&mut context, &mut image, selector),
            Err(Failure::Protection(ProtectionFault {
                vector,
                error_code: selector & 0xfffc,
                phase,
                selector: Some(selector),
            }))
        );
        assert_eq!(context, before);
        assert_eq!(image.read_vector(0x1008, 8).unwrap(), {
            let mut expected = [0; 16];
            expected[..8].copy_from_slice(&low.to_le_bytes());
            expected
        });
    }
}

#[test]
fn ltr_requires_entire_descriptor_write_admission_before_busy_or_cache_publication() {
    let mut context = configured("long64");
    let before = context.clone();
    let low = 0x1200_8934_5000_0067;
    let mut image = image(
        descriptor(low, 0xffff_8000),
        vec![
            mapping(0x1000, 0, 13, true, false),
            mapping(0x100d, 13, 1, true, true),
            mapping(0x100e, 14, 34, true, false),
        ],
    );
    let failure = load(&mut context, &mut image, 8).unwrap_err();
    assert!(matches!(
        failure,
        Failure::SystemMemory(SystemMemoryFault {
            address: 0x1008,
            width: 16,
            access: Access::Write,
            cause: Cause::Permission,
            failing_address: 0x1008,
            phase: SystemPhase::BusyWrite,
            ..
        })
    ));
    assert_eq!(context, before);
    assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], 0x89);
}

#[test]
fn ltr_extended_extent_precedes_low_read_and_high_type_or_base_precedes_write() {
    let mut short = configured("long64");
    short.set_gdtr(TableRegister {
        base: 0x9000,
        limit: 15,
    });
    let mut inaccessible = image(vec![0; 48], vec![mapping(0x1000, 0, 48, true, true)]);
    assert_eq!(
        load(&mut short, &mut inaccessible, 8),
        Err(Failure::Protection(ProtectionFault {
            vector: 13,
            error_code: 8,
            phase: ProtectionPhase::Selector,
            selector: Some(8),
        }))
    );
    for upper in [0x1000_ffff_8000u64, 0x0000_8000] {
        let mut context = configured("long64");
        let before = context.clone();
        let mut image = image(
            descriptor(0x1200_8934_5000_0067, upper),
            vec![mapping(0x1000, 0, 48, true, false)],
        );
        assert_eq!(
            load(&mut context, &mut image, 8),
            Err(Failure::Protection(ProtectionFault {
                vector: 13,
                error_code: 8,
                phase: ProtectionPhase::Descriptor,
                selector: Some(8),
            }))
        );
        assert_eq!(context, before);
        assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], 0x89);
    }
}

#[test]
fn task_store_reads_loaded_selector_and_load_privilege_precedes_explicit_operand() {
    let mut context = context("protected", 3);
    context.set_tr(TaskRegister {
        selector: 0x28,
        valid: false,
        ..TaskRegister::default()
    });
    let mut image = image(vec![0xa5; 48], vec![mapping(0x1000, 0, 48, true, true)]);
    let run = |context: &mut ExecutionContext, image: &mut Image, kind, width, memory, offset| {
        execute(
            context,
            image,
            ProtectionDescriptor {
                kind,
                width,
                memory,
            },
            offset,
            0xffff,
            Segment::Ds,
        )
    };
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::ReadTask,
            Width::W32,
            false,
            0
        )
        .unwrap()
        .value,
        Some(0x28)
    );
    run(
        &mut context,
        &mut image,
        ProtectionKind::ReadTask,
        Width::W16,
        true,
        0x1001,
    )
    .unwrap();
    assert_eq!(
        &image.read_vector(0x1000, 4).unwrap()[..4],
        &[0xa5, 0x28, 0, 0xa5]
    );
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadTask,
            Width::W16,
            true,
            0x9000
        ),
        Err(Failure::Protection(ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: ProtectionPhase::Privilege,
            selector: None,
        }))
    );
}

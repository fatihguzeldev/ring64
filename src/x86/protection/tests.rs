use super::*;
use crate::memory::{MappingInput, MemoryLimits, Permissions};
use crate::x86::context::TableRegister;
use serde_json::json;

pub(super) fn context(mode: &str, cpl: u8) -> ExecutionContext {
    let mut value = ExecutionContext::default().to_json();
    value["mode"] = json!(mode);
    value["cpl"] = json!(cpl);
    if mode == "virtual8086" {
        for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
            value["segments"][name]["selector"] = json!(0);
            value["segments"][name]["base"] = json!("0x0");
            value["segments"][name]["limit"] = json!(0xffff);
            value["segments"][name]["type"] = json!("read-write");
            value["segments"][name]["default32"] = json!(false);
        }
    }
    ExecutionContext::from_json(&value).unwrap()
}

pub(super) fn mapping(
    base: u64,
    offset: u32,
    length: u32,
    read: bool,
    write: bool,
) -> MappingInput {
    MappingInput {
        base,
        offset,
        length,
        backing: "data".into(),
        permissions: Permissions {
            read,
            write,
            execute: true,
        },
    }
}

pub(super) fn image(bytes: Vec<u8>, mappings: Vec<MappingInput>) -> Image {
    Image::mapped(
        vec![("data".into(), bytes)],
        mappings,
        MemoryLimits {
            max_backing_bytes: 4096,
            max_backings: 1,
            max_mappings: 16,
        },
    )
    .unwrap()
}

pub(super) fn flat() -> Image {
    image(vec![0; 256], vec![mapping(0x1000, 0, 256, true, true)])
}

pub(super) fn run(
    context: &mut ExecutionContext,
    image: &mut Image,
    kind: ProtectionKind,
    width: Width,
    memory: bool,
    offset: u64,
    input: u64,
) -> Result<Outcome, Failure> {
    execute(
        context,
        image,
        ProtectionDescriptor {
            kind,
            width,
            memory,
        },
        offset,
        input,
        Segment::Ds,
    )
}

#[test]
fn private_helper_mode_gate_accepts_selected_forms_without_creating_missing_instructions() {
    let long = context("long64", 0);
    let protected = context("protected", 0);
    let real = context("real", 0);
    let v86 = context("virtual8086", 3);
    let valid = |kind, width, memory, ctx| {
        valid_in_mode(
            ProtectionDescriptor {
                kind,
                width,
                memory,
            },
            ctx,
        )
    };
    assert!(valid(ProtectionKind::LoadGdt, Width::W16, true, &long));
    assert!(valid(
        ProtectionKind::LoadFar(Segment::Ss),
        Width::W64,
        true,
        &long
    ));
    assert!(valid(
        ProtectionKind::LoadFar(Segment::Ds),
        Width::W32,
        true,
        &protected
    ));
    assert!(valid(
        ProtectionKind::LoadFar(Segment::Ss),
        Width::W16,
        true,
        &real
    ));
    assert!(!valid(
        ProtectionKind::LoadFar(Segment::Ds),
        Width::W32,
        true,
        &long
    ));
    assert!(!valid(ProtectionKind::ReadLdt, Width::W16, false, &v86));
    assert!(!valid(ProtectionKind::Lar, Width::W16, false, &real));
    assert!(!valid(ProtectionKind::Lar, Width::W64, false, &protected));
    assert!(valid(
        ProtectionKind::LoadSegment(Segment::Ss),
        Width::W16,
        false,
        &long
    ));
    assert!(!valid(ProtectionKind::LoadGdt, Width::W32, false, &long));
}

#[test]
fn query_literals_return_selected_width_without_loading_cache_or_setting_accessed() {
    for mode in ["protected", "compatibility", "long64"] {
        let mut context = context(mode, 0);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 15,
        });
        let before = context.clone();
        let mut image = flat();
        image.write(0x1008, 8, 0x12ca_9a34_0000_3456).unwrap();
        for (kind, width, expected) in [
            (ProtectionKind::Lar, Width::W16, 0x9a00),
            (ProtectionKind::Lar, Width::W32, 0xc09a00),
            (ProtectionKind::Lsl, Width::W16, 0x6fff),
            (ProtectionKind::Lsl, Width::W32, 0xa3456fff),
        ] {
            assert_eq!(
                run(
                    &mut context,
                    &mut image,
                    kind,
                    width,
                    false,
                    0,
                    0xffff_ffff_0000_0008
                ),
                Ok(Outcome {
                    value: Some(expected),
                    zero: Some(true),
                    context_changed: false
                })
            );
        }
        assert_eq!(context, before);
        assert_eq!(image.read(0x1008, 8).unwrap(), 0x12ca_9a34_0000_3456);
    }
}

#[test]
fn failed_query_has_no_destination_and_null_or_short_lookup_never_probes_memory() {
    let mut context = context("long64", 3);
    context.set_gdtr(TableRegister {
        base: 0x5000,
        limit: 14,
    });
    let mut image = flat();
    for selector in [0, 1, 2, 3, 4, 8] {
        for kind in [
            ProtectionKind::Lar,
            ProtectionKind::Lsl,
            ProtectionKind::Verr,
            ProtectionKind::Verw,
        ] {
            let width = if matches!(kind, ProtectionKind::Verr | ProtectionKind::Verw) {
                Width::W16
            } else {
                Width::W32
            };
            assert_eq!(
                run(&mut context, &mut image, kind, width, false, 0, selector),
                Ok(Outcome {
                    value: None,
                    zero: Some(false),
                    context_changed: false
                })
            );
        }
    }
}

#[test]
fn query_system_tails_follow_type_visibility_and_extent_before_required_access() {
    let mut context = context("long64", 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 23,
    });
    let mut image = image(
        0x0000_8200_0000_1234u64.to_le_bytes().to_vec(),
        vec![mapping(0x1008, 0, 8, true, true)],
    );
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::Lar,
            Width::W64,
            false,
            0,
            8
        )
        .unwrap()
        .value,
        Some(0x8200)
    );
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::Lsl,
            Width::W64,
            false,
            0,
            8
        ),
        Err(Failure::SystemMemory(SystemMemoryFault {
            address: 0x1010,
            width: 8,
            access: Access::Read,
            cause: Cause::Unmapped,
            failing_address: 0x1010,
            phase: SystemPhase::DescriptorRead,
            table: Table::Gdt,
            reference: SystemReference::Selector(8),
        }))
    );
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
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
        .unwrap()
        .zero,
        Some(false)
    );
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 23,
    });
    image.write(0x1008, 8, 0x0000_8000_0000_1234).unwrap();
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
        .unwrap()
        .zero,
        Some(false)
    );
}

#[test]
fn pseudo_descriptor_write_needs_only_write_and_load24_ignores_but_admits_last_byte() {
    let mut context = context("protected", 0);
    context.set_gdtr(TableRegister {
        base: 0x1234_5678,
        limit: 0xabcd,
    });
    let mut image = image(vec![0xa5; 8], vec![mapping(0x1000, 0, 8, false, true)]);
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::StoreGdt,
            Width::W16,
            true,
            0x1001,
            0
        )
        .unwrap(),
        Outcome::default()
    );
    image
        .set_mappings(vec![mapping(0x1000, 0, 8, true, false)])
        .unwrap();
    assert_eq!(
        image.read_bytes(0x1000, 8).unwrap(),
        [0xa5, 0xcd, 0xab, 0x78, 0x56, 0x34, 0x12, 0xa5]
    );
    assert!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadIdt,
            Width::W16,
            true,
            0x1001,
            0
        )
        .unwrap()
        .context_changed
    );
    assert_eq!(
        context.idtr(),
        TableRegister {
            base: 0x345678,
            limit: 0xabcd
        }
    );
    let old = context.clone();
    image
        .set_mappings(vec![mapping(0x1000, 0, 6, true, false)])
        .unwrap();
    assert!(matches!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadIdt,
            Width::W16,
            true,
            0x1001,
            0
        ),
        Err(Failure::Operand(_))
    ));
    assert_eq!(context, old);
}

#[test]
fn privileged_roots_fail_before_operand_and_long_base_content_is_checked_without_table_probe() {
    let mut context = context("long64", 3);
    let mut image = flat();
    for kind in [
        ProtectionKind::LoadGdt,
        ProtectionKind::LoadIdt,
        ProtectionKind::LoadLdt,
    ] {
        assert_eq!(
            run(&mut context, &mut image, kind, Width::W16, true, 0x5000, 0),
            Err(Failure::Protection(ProtectionFault {
                vector: 13,
                error_code: 0,
                phase: ProtectionPhase::Privilege,
                selector: None,
            }))
        );
    }
    context = self::context("long64", 0);
    let old = context.clone();
    image
        .write_bytes(0x1000, &[0xff, 0xff, 0, 0, 0, 0, 0, 0x80, 0, 0])
        .unwrap();
    assert_eq!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadGdt,
            Width::W16,
            true,
            0x1000,
            0
        ),
        Err(Failure::Protection(ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: ProtectionPhase::Descriptor,
            selector: None,
        }))
    );
    assert_eq!(context, old);
    image
        .write_bytes(0x1000, &[0xff, 0xff, 0, 0, 0, 0, 0, 0x80, 0xff, 0xff])
        .unwrap();
    assert!(
        run(
            &mut context,
            &mut image,
            ProtectionKind::LoadGdt,
            Width::W16,
            true,
            0x1000,
            0
        )
        .unwrap()
        .context_changed
    );
    assert_eq!(
        context.gdtr(),
        TableRegister {
            base: 0xffff800000000000,
            limit: 0xffff
        }
    );
}

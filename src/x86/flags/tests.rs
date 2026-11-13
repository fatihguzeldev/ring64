use super::*;
use crate::x86::instruction::{SystemFlagsDescriptor, SystemFlagsKind};

fn context(mode: &str, cpl: u8) -> ExecutionContext {
    let mut value = ExecutionContext::default().to_json();
    value["mode"] = serde_json::json!(mode);
    value["cpl"] = serde_json::json!(cpl);
    if mode == "virtual8086" {
        for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
            value["segments"][name]["selector"] = serde_json::json!(0);
            value["segments"][name]["base"] = serde_json::json!("0x0");
            value["segments"][name]["limit"] = serde_json::json!(0xffff);
            value["segments"][name]["default32"] = serde_json::json!(false);
            value["segments"][name]["type"] = serde_json::json!("read-write");
        }
    }
    ExecutionContext::from_json(&value).unwrap()
}

#[test]
fn ac_selected_forms_have_distinct_checked_operation_words() {
    for (word, kind) in [(12, SystemFlagsKind::Clac), (13, SystemFlagsKind::Stac)] {
        assert_eq!(
            SystemFlagsDescriptor::try_decode(word),
            Some(SystemFlagsDescriptor {
                kind,
                width: Width::W16
            })
        );
    }
}

#[test]
fn system_flags_words_preserve_old_encodings_and_reject_every_reserved_bit() {
    let selected = [
        (0, SystemFlagsKind::Push, Width::W16),
        (1, SystemFlagsKind::Pop, Width::W16),
        (2, SystemFlagsKind::Cli, Width::W16),
        (3, SystemFlagsKind::Sti, Width::W16),
        (4, SystemFlagsKind::Push, Width::W32),
        (5, SystemFlagsKind::Pop, Width::W32),
        (8, SystemFlagsKind::Push, Width::W64),
        (9, SystemFlagsKind::Pop, Width::W64),
        (12, SystemFlagsKind::Clac, Width::W16),
        (13, SystemFlagsKind::Stac, Width::W16),
    ];
    for word in 0..=255 {
        let expected = selected.iter().find_map(|&(encoded, kind, width)| {
            (encoded == word).then_some(SystemFlagsDescriptor { kind, width })
        });
        assert_eq!(SystemFlagsDescriptor::try_decode(word), expected, "{word}");
        if let Some(operation) = expected {
            assert_eq!(operation.encode(), word);
            for bit in 4..32 {
                assert_eq!(
                    SystemFlagsDescriptor::try_decode(word | (1 << bit)),
                    None,
                    "{word}/{bit}"
                );
            }
        }
    }
}

#[test]
fn ac_admission_uses_cpl_and_v86_but_no_paging_or_iopl_gate() {
    for mode in [
        "real",
        "protected",
        "compatibility",
        "long64",
        "virtual8086",
    ] {
        for cpl in 0..4 {
            if mode == "real" && cpl != 0 || mode == "virtual8086" && cpl != 3 {
                continue;
            }
            let c = context(mode, cpl);
            for flags in [2, 0x3002, 0x40002, 0x3d7fd7] {
                for set in [false, true] {
                    let expected = if mode != "virtual8086" && cpl == 0 {
                        Some(if set {
                            flags | 0x40000
                        } else {
                            flags & !0x40000
                        })
                    } else {
                        None
                    };
                    assert_eq!(
                        alignment_check(flags, set, &c),
                        expected,
                        "{mode}/{cpl}/{flags:x}/{set}"
                    );
                }
            }
        }
    }
}

#[test]
fn flags_stack_images_use_literal_reserved_rf_vm_and_width_rules() {
    let long = ExecutionContext::default();
    assert_eq!(push(0x3d7fd7, Width::W64, &long), Ok(0x3c7fd7));
    assert_eq!(push(0x3d7fd7, Width::W16, &long), Ok(0x7fd7));
    assert_eq!(pop(0x190002, u64::MAX, Width::W64, &long), Ok(0x3c7fd7));
    assert_eq!(pop(0x190002, u64::MAX, Width::W16, &long), Ok(0x187fd7));
    assert_eq!(architectural(0x3002, &context("virtual8086", 3)), 0x23002);
}

#[test]
fn privilege_matrix_uses_old_iopl_and_preserves_virtual_bits() {
    for mode in [
        "real",
        "protected",
        "compatibility",
        "long64",
        "virtual8086",
    ] {
        for cpl in 0..4 {
            if mode == "real" && cpl != 0 || mode == "virtual8086" && cpl != 3 {
                continue;
            }
            let c = if mode == "long64" {
                context("long64", cpl)
            } else {
                context(mode, cpl)
            };
            for iopl in 0..4 {
                let input = 2 | (iopl << 12) | 0x180000;
                let admitted = mode != "virtual8086" || iopl == 3;
                assert_eq!(
                    admit_stack(input, &c).is_ok(),
                    admitted,
                    "{mode} {cpl} {iopl}"
                );
                assert_eq!(push(input, Width::W16, &c).is_ok(), admitted);
                assert_eq!(pop(input, 0xffff_ffff, Width::W32, &c).is_ok(), admitted);
                let permits_if = mode == "real"
                    || if mode == "virtual8086" {
                        iopl == 3
                    } else {
                        u64::from(cpl) <= iopl
                    };
                for set in [false, true] {
                    let old = input | if set { 0 } else { IF };
                    let result = interrupt(old, set, &c);
                    if permits_if {
                        assert_eq!(
                            result,
                            Ok(if set { old | IF } else { old & !IF }),
                            "{mode} {cpl} {iopl}"
                        );
                    } else {
                        assert_eq!(result, Err(denied()));
                    }
                }
                if admitted {
                    let result = pop(input, u64::MAX, Width::W32, &c).unwrap();
                    assert_eq!(result & 0x180000, 0x180000);
                    assert_eq!(result & IF, if permits_if { IF } else { 0 });
                    assert_eq!(
                        result & 0x3000,
                        if mode == "real" || cpl == 0 {
                            0x3000
                        } else {
                            iopl << 12
                        }
                    );
                    assert_eq!(result & 0x2441d5, 0x2441d5);
                }
            }
        }
    }
}

#[test]
fn popf_literal_clears_and_preservation_distinguish_old_privilege_and_selected_width() {
    for (mode, cpl, flags, input, width, expected) in [
        ("long64", 3, 0x190002, u64::MAX, Width::W64, 0x3c4dd7),
        ("protected", 1, 0x190202, 0, Width::W32, 0x180202),
        ("protected", 1, 0x191202, 0, Width::W32, 0x181002),
        ("protected", 3, 0x193202, 0, Width::W32, 0x183002),
        ("real", 0, 0x193202, 0, Width::W32, 0x180002),
        ("virtual8086", 3, 0x193202, 0, Width::W32, 0x183002),
        ("long64", 0, 0x3d7fd7, 0, Width::W16, 0x3c0002),
    ] {
        assert_eq!(pop(flags, input, width, &context(mode, cpl)), Ok(expected));
    }
}

#[test]
fn private_descriptors_and_shadow_admission_reject_malformed_inputs() {
    for kind in [
        SystemFlagsKind::Push,
        SystemFlagsKind::Pop,
        SystemFlagsKind::Cli,
        SystemFlagsKind::Sti,
        SystemFlagsKind::Clac,
        SystemFlagsKind::Stac,
    ] {
        for width in [Width::W16, Width::W32, Width::W64] {
            let d = SystemFlagsDescriptor { kind, width };
            let valid =
                matches!(kind, SystemFlagsKind::Push | SystemFlagsKind::Pop) || width == Width::W16;
            assert_eq!(
                SystemFlagsDescriptor::try_decode(d.encode()),
                valid.then_some(d)
            );
        }
    }
    for word in [14, 15, 16, 17, 31, u32::MAX] {
        assert_eq!(SystemFlagsDescriptor::try_decode(word), None);
    }
    for bits in 0..8 {
        assert_eq!(valid_interruptibility(2, bits), bits == 0 || bits == 2);
        assert_eq!(valid_interruptibility(0x202, bits), bits <= 2);
    }
    let long = ExecutionContext::default();
    let protected = context("protected", 0);
    for width in [Width::W8, Width::W16, Width::W32, Width::W64] {
        let d = SystemFlagsDescriptor {
            kind: SystemFlagsKind::Push,
            width,
        };
        assert_eq!(
            d.valid_in_mode(&long),
            matches!(width, Width::W16 | Width::W64)
        );
        assert_eq!(
            d.valid_in_mode(&protected),
            matches!(width, Width::W16 | Width::W32)
        );
    }
}

use super::*;
use crate::x86::context::ExecutionContext;

#[test]
fn streaming_selected_forms_are_admitted_with_complete_lengths() {
    for code in [
        &[0x0f, 0xf7, 0xc4][..],
        &[0x66, 0x45, 0x0f, 0xf7, 0xc5],
        &[0x0f, 0xe7, 0x03],
        &[0x66, 0x44, 0x0f, 0xe7, 0x03],
        &[0x0f, 0x2b, 0x03],
        &[0x66, 0x0f, 0x2b, 0x03],
        &[0x0f, 0xc3, 0x03],
        &[0x4c, 0x0f, 0xc3, 0x03],
        &[0x0f, 0xae, 0x3b],
        &[0xf3, 0x41, 0x90],
        &[0x66, 0xf3, 0x49, 0x90],
        &[0x0f, 0x18, 0x84, 0x8b, 1, 2, 3, 4],
        &[0x66, 0xf2, 0xf3, 0x0f, 0x18, 0x03],
    ] {
        let decoded = at(0x1000, code).unwrap_or_else(|e| panic!("{code:02x?}: {e:?}"));
        assert_eq!(decoded.next_pc, 0x1000 + code.len() as u64);
    }
}

#[test]
fn streaming_fences_and_pause_are_operandless_despite_rex_fields() {
    for selector in [5, 6, 7] {
        for rm in 0..8 {
            assert_eq!(
                operation(&[0x4f, 0x0f, 0xae, 0xc0 | selector << 3 | rm]),
                Operation::Nop
            );
        }
    }
    for rex in 0x40..=0x4f {
        assert_eq!(operation(&[0xf3, rex, 0x90]), Operation::Nop);
    }
    assert_eq!(operation(&[0x66, 0xf3, 0x49, 0x90]), Operation::Nop);
    assert_eq!(at(0x1000, &[0xf2, 0x90]), Err(DecodeError::Unsupported));
}

#[test]
fn streaming_wrong_classes_neighbors_and_required_tails_are_distinct() {
    for code in [
        &[0x0f, 0xf7, 0x04][..],
        &[0x66, 0x0f, 0xf7, 0x05],
        &[0x0f, 0xe7, 0xc0],
        &[0x66, 0x0f, 0xe7, 0xc0],
        &[0x0f, 0x2b, 0xc0],
        &[0x66, 0x0f, 0x2b, 0xc0],
        &[0x0f, 0xc3, 0xc0],
    ] {
        assert_eq!(at(0x1000, code), Err(DecodeError::Invalid), "{code:02x?}");
    }
    for code in [
        &[0x0f, 0xae, 0x2c][..],
        &[0x0f, 0xae, 0x34],
        &[0x0f, 0x18, 0x24],
        &[0x0f, 0x18, 0xc0],
        &[0x66, 0x0f, 0xc3, 0x03],
        &[0xf2, 0x0f, 0xf7, 0xc0],
    ] {
        assert_eq!(
            at(0x1000, code),
            Err(DecodeError::Unsupported),
            "{code:02x?}"
        );
    }
    for code in [
        &[0x0f, 0x18, 0x84, 0x8b, 1, 2, 3][..],
        &[0x0f, 0xae, 0xbc, 0x8b, 1, 2, 3],
        &[0xf0, 0x0f, 0xc3, 0x84, 0x8b, 1, 2, 3],
    ] {
        assert!(
            matches!(at(0x1000, code), Err(DecodeError::Fetch(_))),
            "{code:02x?}"
        );
    }
    for code in [
        &[0xf0, 0x0f, 0xc3, 0x03][..],
        &[0xf0, 0x66, 0x0f, 0xf7, 0xc0],
        &[0xf0, 0x0f, 0xae, 0xe8],
        &[0xf0, 0x0f, 0x18, 0x03],
    ] {
        assert_eq!(at(0x1000, code), Err(DecodeError::Invalid), "{code:02x?}");
    }
}

#[test]
fn streaming_movi_uses_32_bits_even_under_16_bit_code_defaults() {
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(
            name.into(),
            serde_json::json!({
                "base":"0x0", "limit":65535, "default32":false,
                "usable":true,"type":if name == "cs" {"readable-code"} else {"read-write"}
            }),
        );
    }
    let context =
        ExecutionContext::from_json(&serde_json::json!({"mode":"protected","segments":segments}))
            .unwrap();
    let bytes = [0x0f, 0xc3, 0x00];
    let instruction = super::super::decode_with_context(0x1000, &context, |pc| {
        bytes
            .get((pc - 0x1000) as usize)
            .copied()
            .ok_or(DecodeError::Unsupported)
    })
    .unwrap();
    assert!(matches!(
        instruction.operation,
        Operation::Store {
            width: Width::W32,
            ..
        }
    ));
}

#[test]
fn streaming_masked_operands_keep_physical_banks_and_implicit_index_ownership() {
    use crate::x86::context::Segment;
    for data in 0..8 {
        for mask in 0..8 {
            for (prefix, mmx, expected_data, expected_mask) in [
                (&[0x67, 0x65, 0x4f][..], true, data, mask),
                (&[0x66, 0x67, 0x65, 0x4f][..], false, data + 8, mask + 8),
            ] {
                let mut code = prefix.to_vec();
                code.extend([0x0f, 0xf7, 0xc0 | data << 3 | mask]);
                assert_eq!(
                    operation(&code),
                    Operation::MaskedStore {
                        data: expected_data,
                        mask: expected_mask,
                        mmx,
                        address: Address {
                            base: AddressBase::Register(7),
                            index: None,
                            displacement: 0,
                            size: Width::W32,
                            segment: Segment::Gs
                        }
                    }
                );
            }
        }
    }
    let Operation::MaskedStore {
        data,
        mask,
        address,
        ..
    } = operation(&[0x4f, 0x66, 0x0f, 0xf7, 0xc5])
    else {
        panic!()
    };
    assert_eq!((data, mask, address.size), (0, 5, Width::W64));
}

#[test]
fn streaming_fetch_boundaries_and_prefix_policy_keep_their_deciding_bytes() {
    let complete = [0x0f, 0x18, 0x84, 0x8b, 1, 2, 3, 4];
    for length in 0..complete.len() {
        assert_eq!(
            at(0x1000, &complete[..length]),
            Err(DecodeError::Fetch(missing(0x1000 + length as u64)))
        );
    }
    for code in [&[0xf0, 0xf0][..], &[0xf0, 0xf3], &[0xf3, 0xf0]] {
        assert_eq!(at(0x1000, code), Err(DecodeError::Unsupported));
    }
    let mut exact = vec![0x66; 13];
    exact.extend([0xf3, 0x90]);
    assert_eq!(operation(&exact), Operation::Nop);
    exact.insert(0, 0x66);
    assert_eq!(at(0x1000, &exact), Err(DecodeError::InstructionLength));
    assert_eq!(operation(&[0xf2, 0xf3, 0x90]), Operation::Nop);
    assert_eq!(
        at(0x1000, &[0xf3, 0xf2, 0x90]),
        Err(DecodeError::Unsupported)
    );
}

#[test]
fn streaming_forms_follow_all_fourteen_imported_profiles_without_word_data_views() {
    let mut profiles = vec![ExecutionContext::default()];
    for mode in ["real", "protected", "compatibility", "virtual8086"] {
        for code32 in [false, true] {
            for stack32 in [false, true] {
                if mode == "virtual8086" && (code32 || stack32) {
                    continue;
                }
                let segments=["cs","ss","ds","es","fs","gs"].into_iter().map(|name|(
                    name.to_owned(),serde_json::json!({"base":"0x0","limit":if mode=="virtual8086" {65535}else{u32::MAX},"default32":if name=="ss" {stack32}else{code32},"usable":true,"type":if name=="cs" && mode!="virtual8086" {"readable-code"}else{"read-write"}})
                )).collect::<serde_json::Map<String,serde_json::Value>>();
                profiles.push(
                    ExecutionContext::from_json(
                        &serde_json::json!({"mode":mode,"segments":segments}),
                    )
                    .unwrap(),
                );
            }
        }
    }
    assert_eq!(profiles.len(), 14);
    for context in profiles {
        for address_override in [false, true] {
            for code in [
                &[0x0f, 0xf7, 0xc1][..],
                &[0x66, 0x0f, 0xf7, 0xc1],
                &[0x0f, 0xe7, 0x03],
                &[0x66, 0x0f, 0xe7, 0x03],
                &[0x0f, 0x2b, 0x03],
                &[0x66, 0x0f, 0x2b, 0x03],
                &[0x0f, 0xc3, 0x03],
                &[0x0f, 0xae, 0xe8],
                &[0x0f, 0xae, 0xf0],
                &[0x0f, 0xae, 0xf8],
                &[0x0f, 0x18, 0x03],
                &[0x0f, 0x18, 0x0b],
                &[0x0f, 0x18, 0x13],
                &[0x0f, 0x18, 0x1b],
                &[0xf3, 0x90],
                &[0x0f, 0xae, 0x3b],
            ] {
                let mut bytes = vec![];
                if address_override {
                    bytes.push(0x67)
                }
                bytes.extend(code);
                let decoded = super::super::decode_with_context(0x1000, &context, |pc| {
                    bytes
                        .get((pc - 0x1000) as usize)
                        .copied()
                        .ok_or(DecodeError::Unsupported)
                })
                .unwrap();
                assert_eq!(decoded.next_pc, 0x1000 + bytes.len() as u64);
                if let Operation::Store { width, .. } = decoded.operation {
                    assert_eq!(width, Width::W32)
                }
                if let Operation::MaskedStore { address, .. } = decoded.operation {
                    let size = if context.is_long64() {
                        if address_override {
                            Width::W32
                        } else {
                            Width::W64
                        }
                    } else if context.code32() != address_override {
                        Width::W32
                    } else {
                        Width::W16
                    };
                    assert_eq!(
                        (address.base, address.size),
                        (AddressBase::Register(7), size)
                    );
                }
            }
        }
    }
}

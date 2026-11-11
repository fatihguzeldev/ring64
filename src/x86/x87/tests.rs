use super::*;
fn op(kind: Kind, format: Format) -> Op {
    Op {
        kind,
        format,
        ..Op::default()
    }
}
fn one() -> u128 {
    0x3fff8000000000000000
}
fn stacked(values: &[u128]) -> State {
    let mut s = State::default();
    for (i, &v) in values.iter().enumerate() {
        s.put(i, v)
    }
    s
}
#[test]
fn integer_load_keeps_all_64_significand_bits_at_pc24() {
    let mut s = State {
        control_word: 0x7f,
        ..State::default()
    };
    eval(
        &mut s,
        op(Kind::Load, Format::I64),
        0x0020000000000001,
        0xcd7,
    );
    assert_eq!(s.raw(7), 0x40348000000000000400);
    assert_eq!((s.status_word, s.tag_word), (0x3800, 0x3fff));
}
#[test]
fn direct_precision_and_unmasked_precision_write_before_wait() {
    for (cw, want, status) in [
        (0x37f, one() + 8, 0),
        (0x27f, one(), 0x20),
        (0xa7f, one() + 0x800, 0x220),
        (0x25f, one(), 0x80a0),
    ] {
        let mut s = stacked(&[one(), 0x3fc38000000000000000]);
        s.control_word = cw;
        eval(
            &mut s,
            Op {
                index: 1,
                ..op(Kind::Add, Format::Register)
            },
            0,
            0xcd7,
        );
        assert_eq!(s.raw(0), want);
        assert_eq!(s.status_word & 0xbaff, status);
    }
}
#[test]
fn constants_clear_old_c1_and_do_not_apply_pc() {
    for (cw, want) in [
        (0x7f, 0xc90fdaa22168c235),
        (0x47f, 0xc90fdaa22168c234),
        (0x87f, 0xc90fdaa22168c235),
        (0xc7f, 0xc90fdaa22168c234),
    ] {
        let mut s = State {
            control_word: cw,
            status_word: 0x200,
            ..State::default()
        };
        eval(
            &mut s,
            Op {
                index: 3,
                ..op(Kind::Constant, Format::None)
            },
            0,
            0xcd7,
        );
        assert_eq!(s.raw(7), 0x40000000000000000000 | want);
        assert_eq!(s.status_word & 0xbaff, 0x3800);
    }
}
#[test]
fn struct_layout_and_op_roundtrip() {
    assert_eq!(std::mem::size_of::<State>(), 104);
    let a = Op {
        kind: Kind::SubReverse,
        format: Format::Register,
        index: 7,
        dest_index: true,
        pop: 1,
        condition: 0,
        encoding: 0x7ff,
    };
    assert_eq!(Op::decode(a.encode()), a);
}
#[test]
fn direct_rounding_cancellation_and_extended_range() {
    let cases = [
        (
            0x7f,
            one(),
            0xbffefffffffffffffffe,
            0x3fc08000000000000000,
            0,
        ),
        (
            0x7f,
            one() + 0x8000000000,
            0x3fbe8000000000000000,
            one() + 0x10000000000,
            0x220,
        ),
        (
            0x27f,
            one() + 0x400,
            0x3fbe8000000000000000,
            one() + 0x800,
            0x220,
        ),
        (
            0x27f,
            0x43fe8000000000000000,
            0x43fe8000000000000000,
            0x43ff8000000000000000,
            0,
        ),
    ];
    for (cw, a, b, want, flags) in cases {
        let mut s = stacked(&[a, b]);
        s.control_word = cw;
        eval(
            &mut s,
            Op {
                index: 1,
                ..op(Kind::Add, Format::Register)
            },
            0,
            0,
        );
        assert_eq!(s.raw(0), want, "{cw:x}/{a:x}/{b:x}");
        assert_eq!(s.status_word & 0xbaff, flags);
    }
}
#[test]
fn store_rounding_and_precision_can_commit_pops_while_invalid_does_not() {
    let mut s = stacked(&[0x3fff8000008000000001]);
    let r = eval(
        &mut s,
        Op {
            pop: 1,
            ..op(Kind::Store, Format::F32)
        },
        0,
        0,
    );
    assert_eq!(
        (r.value, r.store, s.status_word & 0xbaff, s.tag_word),
        (0x3f800001, true, 0xa20, 0xffff)
    );
    let mut s = stacked(&[0x3fffc000000000000000]);
    s.control_word = 0x35f;
    let r = eval(
        &mut s,
        Op {
            pop: 1,
            ..op(Kind::Store, Format::I32)
        },
        0,
        0,
    );
    assert_eq!(
        (r.value, r.store, s.status_word & 0xbaff, s.tag_word),
        (2, true, 0x8aa0, 0xffff)
    );
    let mut s = stacked(&[0x7fff8000000000000000]);
    s.control_word = 0x37e;
    let r = eval(
        &mut s,
        Op {
            pop: 1,
            ..op(Kind::Store, Format::I32)
        },
        0,
        0,
    );
    assert!(!r.store);
    assert_eq!((s.top(), s.status_word & 0xbaff), (0, 0x8081));
}
#[test]
fn masked_stack_and_empty_examination_keep_physical_storage() {
    let mut s = stacked(&[one(); 8]);
    eval(&mut s, op(Kind::Constant, Format::None), 0, 0);
    assert_eq!(
        (s.raw(7), s.status_word & 0xbaff, s.tag_word),
        (0xffffc000000000000000, 0x3a41, 0x8000)
    );
    let mut s = State::default();
    s.set_raw(0, 0x80000000000000000000);
    eval(&mut s, op(Kind::Examine, Format::None), 0, 0);
    assert_eq!(s.status_word, 0x4300);
    assert_eq!(s.tag_word, 0xffff);
    let mut s = stacked(&[one()]);
    s.status_word = 0x200;
    eval(
        &mut s,
        Op {
            index: 1,
            ..op(Kind::ConditionalMove, Format::Register)
        },
        0,
        0,
    );
    assert_eq!(
        (s.raw(0), s.status_word & 0xbaff, s.tag(0)),
        (0xffffc000000000000000, 0x41, 2)
    );
}
#[test]
fn overflow_underflow_wrapping_differs_from_suppressed_float_stores() {
    for (cw, a, b, want, sw) in [
        (
            0x377,
            0x7ffeffffffffffffffff,
            0x40008000000000000000,
            0x1fffffffffffffffffff,
            0x8088,
        ),
        (
            0x36f,
            0x00018000000000000000,
            0x3ffe8000000000000000,
            0x60008000000000000000,
            0x8090,
        ),
    ] {
        let mut s = stacked(&[a, b]);
        s.control_word = cw;
        eval(
            &mut s,
            Op {
                index: 1,
                ..op(Kind::Mul, Format::Register)
            },
            0,
            0,
        );
        assert_eq!((s.raw(0), s.status_word & 0xbaff), (want, sw));
    }
    for (cw, a, sw) in [
        (0x377, 0x407f8000000000000000, 0x8088),
        (0x36f, 0x3f698000000000000000, 0x8090),
    ] {
        let mut s = stacked(&[a]);
        s.control_word = cw;
        let r = eval(
            &mut s,
            Op {
                pop: 1,
                ..op(Kind::Store, Format::F32)
            },
            0,
            0,
        );
        assert!(!r.store);
        assert_eq!((s.top(), s.status_word & 0xbaff), (0, sw));
    }
}
#[test]
fn denormal_loads_push_with_unmasked_de_but_ext80_loads_are_raw() {
    let mut s = State {
        control_word: 0x37d,
        ..State::default()
    };
    eval(&mut s, op(Kind::Load, Format::F32), 1, 0);
    assert_eq!(
        (s.raw(7), s.status_word & 0xbaff, s.tag_word),
        (0x3f6a8000000000000000, 0xb882, 0x3fff)
    );
    let mut s = State {
        control_word: 0x37d,
        ..State::default()
    };
    eval(&mut s, op(Kind::Load, Format::F80), 1, 0);
    assert_eq!(
        (s.raw(7), s.status_word & 0xbaff, s.tag_word),
        (1, 0x3800, 0xbfff)
    );
}
#[test]
fn flags_comparisons_keep_unconditional_clears_on_unmasked_invalid() {
    let mut s = stacked(&[0x7fffc000000000000011, one()]);
    s.control_word = 0x37e;
    s.status_word = 0x4700;
    let r = eval(
        &mut s,
        Op {
            index: 1,
            pop: 1,
            ..op(Kind::CompareFlags, Format::Register)
        },
        0,
        0xc92,
    );
    assert_eq!(r.flags, 0x402);
    assert_eq!(s.top(), 0);
    assert_eq!(s.status_word, 0xc581);
}
#[test]
fn init_and_clear_preserve_payloads_and_status_reads_only_supply_ax() {
    let mut s = stacked(&[one(); 8]);
    s.control_word = 0x37b;
    s.status_word = 0xa884;
    let raw = s.registers;
    let r = eval(&mut s, op(Kind::StoreStatus, Format::Ax), 0, 0xcd7);
    assert_eq!((r.value, r.ax, r.flags), (0xa884, true, 0xcd7));
    eval(&mut s, op(Kind::Init, Format::None), 0, 0);
    assert_eq!(s.registers, raw);
    assert_eq!(
        (s.control_word, s.status_word, s.tag_word),
        (0x37f, 0, 0xffff)
    );
}
#[test]
fn square_root_uses_integer_restoring_bits_at_all_rounds() {
    for (cw, want, sw) in [
        (0x37f, 0x3fffb504f333f9de6484, 0x20),
        (0x77f, 0x3fffb504f333f9de6484, 0x20),
        (0xb7f, 0x3fffb504f333f9de6485, 0x220),
        (0xf7f, 0x3fffb504f333f9de6484, 0x20),
    ] {
        let mut s = stacked(&[0x40008000000000000000]);
        s.control_word = cw;
        eval(&mut s, op(Kind::Sqrt, Format::None), 0, 0);
        assert_eq!((s.raw(0), s.status_word & 0xbaff), (want, sw));
    }
}
#[test]
fn flags_comparisons_do_not_report_denormal_operands() {
    for kind in [Kind::CompareFlags, Kind::CompareUnorderedFlags] {
        let mut s = stacked(&[1, one()]);
        s.control_word = 0x37d;
        let r = eval(
            &mut s,
            Op {
                index: 1,
                ..op(kind, Format::Register)
            },
            0,
            0xcd7,
        );
        assert_eq!(s.status_word & 0xbaff, 0);
        assert_eq!(r.flags, 0x403);
        assert_eq!(s.pending(), 0);
    }
    let mut s = stacked(&[1, one()]);
    s.control_word = 0x37d;
    eval(
        &mut s,
        Op {
            index: 1,
            ..op(Kind::Compare, Format::Register)
        },
        0,
        0xcd7,
    );
    assert_eq!(s.status_word & 0xbaff, 0x8082);
}
#[test]
fn integer_stores_round_before_signed_range_checks_without_denormal_flag() {
    for (format, min, positive_over) in [
        (Format::I16, 0xc00e8000000000000000, 0x400e8000000000000000),
        (Format::I32, 0xc01e8000000000000000, 0x401e8000000000000000),
        (Format::I64, 0xc03e8000000000000000, 0x403e8000000000000000),
    ] {
        let mut s = stacked(&[min]);
        let r = eval(&mut s, op(Kind::Store, format), 0, 0);
        let width = if format == Format::I16 {
            16
        } else if format == Format::I32 {
            32
        } else {
            64
        };
        assert_eq!(r.value, 1u128 << (width - 1));
        assert_eq!(s.status_word & 63, 0);
        let mut s = stacked(&[positive_over]);
        let r = eval(&mut s, op(Kind::Store, format), 0, 0);
        assert_eq!(r.value, 1u128 << (width - 1));
        assert_eq!(s.status_word & 63, 1);
    }
    for (cw, want, sw) in [
        (0x37f, 0x80000000, 1),
        (0x77f, 0x7fffffff, 32),
        (0xb7f, 0x80000000, 1),
        (0xf7f, 0x7fffffff, 32),
    ] {
        let mut s = stacked(&[0x401dffffffff00000000]);
        s.control_word = cw;
        let r = eval(&mut s, op(Kind::Store, Format::I32), 0, 0);
        assert_eq!((r.value, s.status_word & 0xbaff), (want, sw));
    }
    let mut s = stacked(&[1]);
    let r = eval(&mut s, op(Kind::Store, Format::I32), 0, 0);
    assert_eq!((r.value, s.status_word & 63), (0, 32));
}
#[test]
fn x87_nan_selection_and_nonarithmetic_raw_operations_are_distinct() {
    for (a, b, want, sw) in [
        (
            0x7fff8000000000000033,
            0x7fffc000000000000011,
            0x7fffc000000000000011,
            1,
        ),
        (
            0x7fffc000000000000011,
            0xffffc000000000000022,
            0xffffc000000000000022,
            0,
        ),
        (0x3fff0000000000000001, one(), 0xffffc000000000000000, 1),
    ] {
        let mut s = stacked(&[a, b]);
        eval(
            &mut s,
            Op {
                index: 1,
                ..op(Kind::Sub, Format::Register)
            },
            0,
            0,
        );
        assert_eq!((s.raw(0), s.status_word & 0xbaff), (want, sw));
    }
    let snan = 0xffff8000000000000001;
    let mut s = stacked(&[snan, one()]);
    eval(
        &mut s,
        Op {
            index: 1,
            ..op(Kind::Exchange, Format::Register)
        },
        0,
        0,
    );
    assert_eq!(s.raw(1), snan);
    assert_eq!(s.status_word & 63, 0);
    eval(
        &mut s,
        Op {
            index: 1,
            condition: 4,
            ..op(Kind::ConditionalMove, Format::Register)
        },
        0,
        0,
    );
    assert_eq!(s.raw(0), snan);
    assert_eq!(s.status_word & 63, 0);
}
#[test]
fn stores_detect_tininess_at_unbounded_destination_precision() {
    for (raw, masked, unmasked, up) in [
        (0x3f80ffffff0000000000, 48, 16, true),
        (0x3f80ffffff8000000000, 32, 32, true),
    ] {
        let mut s = stacked(&[raw]);
        let r = eval(&mut s, op(Kind::Store, Format::F32), 0, 0);
        assert_eq!(
            (r.value, s.status_word & 0xbaff),
            (0x800000, masked | if up { 0x200 } else { 0 })
        );
        let mut s = stacked(&[raw]);
        s.control_word = 0x36f;
        let r = eval(&mut s, op(Kind::Store, Format::F32), 0, 0);
        if unmasked == 16 {
            assert!(!r.store);
            assert_eq!(s.status_word & 0xbaff, 0x8090)
        } else {
            assert!(r.store);
            assert_eq!((r.value, s.status_word & 0xbaff), (0x800000, 0x220))
        }
    }
}
#[test]
fn constant_results_for_all_controls_are_literal_raw80() {
    let values = [
        (
            0x3fff8000000000000000,
            0x3fff8000000000000000,
            0x3fff8000000000000000,
        ),
        (
            0x4000d49a784bcd1b8afe,
            0x4000d49a784bcd1b8afe,
            0x4000d49a784bcd1b8aff,
        ),
        (
            0x3fffb8aa3b295c17f0bc,
            0x3fffb8aa3b295c17f0bb,
            0x3fffb8aa3b295c17f0bc,
        ),
        (
            0x4000c90fdaa22168c235,
            0x4000c90fdaa22168c234,
            0x4000c90fdaa22168c235,
        ),
        (
            0x3ffd9a209a84fbcff799,
            0x3ffd9a209a84fbcff798,
            0x3ffd9a209a84fbcff799,
        ),
        (
            0x3ffeb17217f7d1cf79ac,
            0x3ffeb17217f7d1cf79ab,
            0x3ffeb17217f7d1cf79ac,
        ),
        (0, 0, 0),
    ];
    for (index, (rn, down, up)) in values.into_iter().enumerate() {
        for (cw, want) in [(0x5f, rn), (0x45f, down), (0x85f, up), (0xc5f, down)] {
            let mut s = State {
                control_word: cw,
                status_word: 0x200,
                ..State::default()
            };
            eval(
                &mut s,
                Op {
                    index: index as u8,
                    ..op(Kind::Constant, Format::None)
                },
                0,
                0,
            );
            assert_eq!((s.raw(7), s.status_word & 0xbaff), (want, 0x3800));
        }
    }
}
#[test]
fn division_and_square_root_exactness_and_direction_are_derived_from_integer_bounds() {
    let floor = 0xb504f333f9de6484u128;
    let remainder = (1u128 << 127) - floor * floor;
    assert!(remainder > 0 && remainder < floor); // sqrt(2) is below the halfway point.
    for (cw, want, sw) in [
        (0x37f, 0x3ffdaaaaaaaaaaaaaaab, 0x220),
        (0x77f, 0x3ffdaaaaaaaaaaaaaaaa, 0x20),
        (0xb7f, 0x3ffdaaaaaaaaaaaaaaab, 0x220),
        (0xf7f, 0x3ffdaaaaaaaaaaaaaaaa, 0x20),
    ] {
        let mut s = stacked(&[one(), 0x4000c000000000000000]);
        s.control_word = cw;
        eval(
            &mut s,
            Op {
                index: 1,
                ..op(Kind::Div, Format::Register)
            },
            0,
            0,
        );
        assert_eq!((s.raw(0), s.status_word & 0xbaff), (want, sw));
    }
}
#[test]
fn pseudo_denormals_use_exponent_one_but_report_denormal_on_arithmetic() {
    // Intel SDM vol. 1 §8.2.2: pseudo-denormals retain the exponent-one value,
    // and generate the denormal operand condition when used by arithmetic.
    for (cw, want, sw) in [
        (0x37f, 0x00018000000000000000, 2),
        (0x37d, 0x00008000000000000000, 0x8082),
    ] {
        let mut s = stacked(&[0x00008000000000000000, 0]);
        s.control_word = cw;
        eval(
            &mut s,
            Op {
                index: 1,
                ..op(Kind::Add, Format::Register)
            },
            0,
            0,
        );
        assert_eq!((s.raw(0), s.status_word & 0xbaff), (want, sw));
    }
    let mut s = State {
        control_word: 0x37d,
        ..State::default()
    };
    eval(
        &mut s,
        op(Kind::Load, Format::F80),
        0x00008000000000000000,
        0,
    );
    assert_eq!(
        (s.raw(7), s.status_word & 0xbaff),
        (0x00008000000000000000, 0x3800)
    );
}

#[test]
fn special_operation_words_have_disjoint_kinds_and_checked_fields() {
    for kind in [
        Kind::Remainder,
        Kind::RemainderNearest,
        Kind::Scale,
        Kind::Extract,
    ] {
        let operation = Op {
            kind,
            encoding: 0x7ff,
            ..Op::default()
        };
        assert_eq!(Op::try_decode(operation.encode()), Some(operation));
        assert!(Op::try_decode(operation.encode() | (1 << 30)).is_none());
        assert!(Op::try_decode(operation.encode() | (1 << 10)).is_none());
    }
    for (kind, pop) in [(Kind::Load, 0), (Kind::Store, 1)] {
        let operation = Op {
            kind,
            format: Format::Bcd,
            pop,
            encoding: 0x733,
            ..Op::default()
        };
        assert_eq!(Op::try_decode(operation.encode()), Some(operation));
        assert_eq!(operation.memory_bytes(), 10);
        assert_eq!(operation.is_store(), kind == Kind::Store);
    }
}

#[test]
fn every_admitted_operation_word_roundtrips_without_field_collisions() {
    for fields in 0..1u32 << 19 {
        for encoding in [0, 0x7ff] {
            let word = fields | encoding << 19;
            if let Some(operation) = Op::try_decode(word) {
                assert_eq!(operation.encode(), word);
            }
        }
    }
    for (kind, format, pop) in [
        (Kind::Store, Format::Bcd, 0),
        (Kind::Load, Format::Bcd, 1),
        (Kind::Add, Format::Bcd, 0),
        (Kind::Extract, Format::Register, 0),
    ] {
        assert!(
            Op::try_decode(
                Op {
                    kind,
                    format,
                    pop,
                    ..Op::default()
                }
                .encode()
            )
            .is_none()
        );
    }
}

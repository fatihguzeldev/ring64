use super::*;

fn initial() -> x87::State {
    let mut s = x87::State {
        control_word: 0x0f7f,
        status_word: 0x6f00,
        tag_word: 0xe4e4,
        opcode: 0x73f,
        instruction_pointer: 0xfedcba9876543210,
        data_pointer: 0x123456789abcdef0,
        ..x87::State::default()
    };
    for i in 0..8 {
        s.set_raw(i, (0x1234u128 << 64) | (0x102030405060708u128 + i as u128));
    }
    s
}

fn assert_environment(before: x87::State, after: x87::State) {
    assert_eq!(after.control_word, before.control_word);
    assert_eq!(after.status_word, before.status_word & !0x3800);
    assert_eq!(after.opcode, before.opcode);
    assert_eq!(after.instruction_pointer, before.instruction_pointer);
    assert_eq!(after.data_pointer, before.data_pointer);
}

#[test]
fn transfers_preserve_payloads_on_reads_and_apply_exact_external_widths() {
    for wide in [false, true] {
        let mut s = initial();
        let before = s;
        let input = 0xfedcba98ffffffffu128;
        let out = eval(
            &mut s,
            Op {
                kind: Kind::FromGpr,
                dst: 7,
                src: 15,
                wide,
                ..Op::default()
            },
            input,
            0,
            0xa55f,
        );
        let low = if wide {
            input as u64
        } else {
            u64::from(input as u32)
        };
        assert_eq!(out.value, u128::from(low));
        assert_eq!(out.mxcsr, 0xa55f);
        assert_eq!(s.raw(7), (0xffffu128 << 64) | u128::from(low));
        assert_environment(before, s);
        for i in 0..7 {
            assert_eq!(s.raw(i), before.raw(i));
        }
        for store in [false, true] {
            let mut s = before;
            s.set_raw(7, (0x8000u128 << 64) | input);
            let payloads = s.registers;
            let op = Op {
                kind: if store { Kind::Store } else { Kind::ToGpr },
                dst: if store { 0 } else { 15 },
                src: 7,
                wide,
                memory: store,
                ..Op::default()
            };
            let out = eval(&mut s, op, u128::MAX, 0, 0xa55f);
            assert_eq!(out.value, u128::from(low));
            assert_eq!(s.registers, payloads);
            assert_eq!(
                op.memory_bytes(),
                if store { if wide { 8 } else { 4 } } else { 0 }
            );
        }
    }
    let mut s = initial();
    let before = s;
    let out = eval(
        &mut s,
        Op {
            kind: Kind::ToXmm,
            dst: 15,
            src: 7,
            ..Op::default()
        },
        0,
        u128::MAX,
        0x1f80,
    );
    assert_eq!(out.value, u128::from(before.raw(7) as u64));
    assert_eq!(s.registers, before.registers);
    assert_environment(before, s);
    let out = eval(
        &mut s,
        Op {
            kind: Kind::FromXmm,
            dst: 7,
            src: 15,
            ..Op::default()
        },
        0xaaaaaaaabbbbbbbb_1122334455667788,
        0,
        0x1f80,
    );
    assert_eq!(out.value, 0x1122334455667788);
    assert_eq!(s.raw(7), 0xffff1122334455667788);
}

#[test]
fn selectors_masks_and_same_bank_capture_use_the_whole_immediate_correctly() {
    let mut s = initial();
    s.set_raw(3, 0x4444333322221111);
    eval(
        &mut s,
        Op {
            kind: Kind::Shuffle,
            dst: 3,
            src: 3,
            immediate: 0x1b,
            ..Op::default()
        },
        0,
        0,
        0x1f80,
    );
    assert_eq!(s.raw(3), 0xffff1111222233334444);
    s.set_raw(3, 0x1122334455667788);
    eval(
        &mut s,
        Op {
            kind: Kind::InsertWord,
            dst: 3,
            src: 15,
            immediate: 0xfd,
            ..Op::default()
        },
        0xaabb,
        0,
        0x1f80,
    );
    assert_eq!(s.raw(3), 0xffff11223344aabb7788);
    let payloads = s.registers;
    let out = eval(
        &mut s,
        Op {
            kind: Kind::ExtractWord,
            dst: 15,
            src: 3,
            immediate: 0xfd,
            ..Op::default()
        },
        0,
        0,
        0x1f80,
    );
    assert_eq!(out.value, 0xaabb);
    assert_eq!(s.registers, payloads);
    s.set_raw(3, 0x800080007f807fff);
    let out = eval(
        &mut s,
        Op {
            kind: Kind::Mask,
            dst: 15,
            src: 3,
            ..Op::default()
        },
        0,
        0,
        0x1f80,
    );
    assert_eq!(out.value, 0xa5);
}

#[test]
fn all_four_float_to_integer_forms_honor_rc_or_truncate_and_ignore_unused_lanes() {
    let rounded = [(2i32, -2i32), (1, -2), (2, -1), (1, -1)];
    for kind in [
        Kind::PsToPi,
        Kind::PdToPi,
        Kind::TruncPsToPi,
        Kind::TruncPdToPi,
    ] {
        let double = matches!(kind, Kind::PdToPi | Kind::TruncPdToPi);
        let trunc = matches!(kind, Kind::TruncPsToPi | Kind::TruncPdToPi);
        let input = if double {
            0xbff8000000000000_3ff8000000000000
        } else {
            0x7fc12345_7f800000_bfc00000_3fc00000
        };
        for rc in 0..4 {
            let mut s = initial();
            let before = s;
            let mxcsr = 0x1f80 | (rc << 13);
            let out = eval(
                &mut s,
                Op {
                    kind,
                    dst: 7,
                    src: 15,
                    ..Op::default()
                },
                input,
                0,
                mxcsr,
            );
            let (a, b) = if trunc { (1, -1) } else { rounded[rc as usize] };
            let expected = u64::from(a as u32) | (u64::from(b as u32) << 32);
            assert_eq!(out.value, u128::from(expected), "{kind:?} rc{rc}");
            assert_eq!(out.mxcsr, mxcsr | 0x20);
            assert_eq!(out.raised, 0x20);
            assert_eq!(out.stage, None);
            assert_eq!(s.raw(7), (0xffffu128 << 64) | u128::from(expected));
            assert_environment(before, s);
            assert_eq!(&s.registers[..7], &before.registers[..7]);
        }
    }
}

#[test]
fn integer_conversions_never_report_denormal_and_daz_changes_directed_rounding() {
    for kind in [
        Kind::PsToPi,
        Kind::PdToPi,
        Kind::TruncPsToPi,
        Kind::TruncPdToPi,
    ] {
        let double = matches!(kind, Kind::PdToPi | Kind::TruncPdToPi);
        let trunc = matches!(kind, Kind::TruncPsToPi | Kind::TruncPdToPi);
        let input = if double {
            0x8000000000000001_0000000000000001
        } else {
            0x7fc12345_7f800000_80000001_00000001
        };
        for rc in 0..4 {
            for daz in [false, true] {
                for ftz in [false, true] {
                    let mut s = initial();
                    let mxcsr = (0x1f80 & !0x100)
                        | (rc << 13)
                        | if daz { 0x40 } else { 0 }
                        | if ftz { 0x8000 } else { 0 };
                    let out = eval(
                        &mut s,
                        Op {
                            kind,
                            dst: 7,
                            src: 15,
                            ..Op::default()
                        },
                        input,
                        0,
                        mxcsr,
                    );
                    let a = if !daz && !trunc && rc == 2 { 1u32 } else { 0 };
                    let b = if !daz && !trunc && rc == 1 {
                        u32::MAX
                    } else {
                        0
                    };
                    assert_eq!(
                        out.value,
                        u128::from(u64::from(a) | (u64::from(b) << 32)),
                        "{kind:?} rc{rc} daz{daz} ftz{ftz}"
                    );
                    assert_eq!(out.raised, if daz { 0 } else { 0x20 });
                    assert_eq!(out.mxcsr, mxcsr | out.raised);
                    assert_eq!(out.stage, None);
                }
            }
        }
    }
}

#[test]
fn exact_integer_to_double_ignores_x87_precision_and_mxcsr_rounding() {
    for memory in [false, true] {
        for rc in 0..4 {
            let mut s = initial();
            s.set_raw(7, 0x12347fffffff80000000);
            let before = s;
            let op = Op {
                kind: Kind::PiToPd,
                dst: 15,
                src: if memory { 0 } else { 7 },
                memory,
                ..Op::default()
            };
            let mxcsr = 0x1f80 | (rc << 13);
            let out = eval(&mut s, op, 0x7fffffff80000000, 0, mxcsr);
            assert_eq!(out.value, 0x41dfffffffc00000_c1e0000000000000);
            assert_eq!(out.mxcsr, mxcsr);
            assert_eq!(out.raised, 0);
            assert_eq!(out.stage, None);
            assert_eq!(s.registers, before.registers);
            if memory {
                assert_eq!(s, before);
            } else {
                assert_environment(before, s);
                assert_eq!(s.tag_word, 0);
            }
        }
    }
}

#[test]
fn descriptor_roundtrips_boundaries_without_extending_mmx_bank_fields() {
    for c in 0..=255 {
        let Some(kind) = kind(c) else { continue };
        for dst in [0, 7, 8, 15] {
            for src in [0, 7, 8, 15] {
                for memory in [false, true] {
                    for wide in [false, true] {
                        for immediate_count in [false, true] {
                            for immediate in [0, 255] {
                                let op = Op {
                                    kind,
                                    dst,
                                    src,
                                    memory,
                                    wide,
                                    immediate_count,
                                    immediate,
                                };
                                if let Some(decoded) = Op::try_decode(op.encode()) {
                                    assert_eq!(decoded, op);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    for kind in [
        Kind::FromGpr,
        Kind::Move,
        Kind::Binary(VectorBinary::Xor),
        Kind::PiToPs,
    ] {
        let op = Op {
            kind,
            dst: 0,
            src: 7,
            ..Op::default()
        };
        assert!(Op::try_decode(op.encode()).is_some());
        assert!(
            Op::try_decode(Op { src: 8, ..op }.encode()).is_none()
                == !matches!(kind, Kind::FromGpr)
        );
    }
}

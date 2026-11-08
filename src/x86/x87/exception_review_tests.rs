use super::*;

const ONE: u128 = 0x3fff8000000000000000;
const INDEFINITE: u128 = 0xffffc000000000000000;
const QUIET: u128 = 1 << 62;
const STATUS: u16 = 0xbaff;

fn state(left: u128, right: u128, masks: u16) -> State {
    let mut state = State {
        control_word: 0x340 | masks,
        status_word: 0x4740,
        tag_word: 0xfff0,
        instruction_pointer: 0x1234,
        data_pointer: 0x5678,
        opcode: 0x345,
        ..State::default()
    };
    for index in 0..8 {
        state.set_raw(index, 0x12340000000000000000 + index as u128);
    }
    state.set_raw(0, left);
    state.set_raw(1, right);
    state
}
fn op(kind: Kind) -> Op {
    Op {
        kind,
        format: Format::Register,
        index: 1,
        ..Op::default()
    }
}

#[test]
fn manual_priority_selects_nan_invalid_and_zero_divide_before_denormal_conditions() {
    // Intel SDM vol. 1 §§4.8.3.5/Table 4-8 and 4.9.2: unsupported/SNaN,
    // QNaN, other invalid/zero-divide, then denormal operand.
    let snan = 0xffff8000000000000033;
    let qnan = 0x7fffc000000000000011;
    for (kind, a, b, flags, value) in [
        (Kind::Add, 0x3fff0000000000000001, snan, 1, INDEFINITE),
        (Kind::Mul, 0x7fff0000000000000000, qnan, 1, INDEFINITE),
        (Kind::Sub, snan, qnan, 1, qnan),
        (Kind::DivReverse, qnan, snan, 1, qnan),
        (
            Kind::Add,
            snan,
            0x7fff8000000000000044,
            1,
            0x7fff8000000000000044 | QUIET,
        ),
        (
            Kind::Add,
            qnan,
            0xffffc000000000000022,
            0,
            0xffffc000000000000022,
        ),
        (Kind::Add, qnan, 1, 0, qnan),
        (Kind::Div, 0, 0, 1, INDEFINITE),
        (Kind::Mul, 0x7fff8000000000000000, 0, 1, INDEFINITE),
        (Kind::Div, 1, 0, 4, 0x7fff8000000000000000),
        (Kind::DivReverse, 0, 1, 4, 0x7fff8000000000000000),
    ] {
        for masks in 0..64 {
            let mut actual = state(a, b, masks);
            let before = actual;
            let effect = eval(&mut actual, op(kind), 0, 0xcd7);
            let trapped = flags & !masks != 0;
            assert_eq!(
                actual.status_word & STATUS,
                0x40 | flags | if trapped { 0x8080 } else { 0 },
                "{kind:?} masks{masks:02x}"
            );
            assert_eq!(
                actual.raw(0),
                if trapped { a } else { value },
                "{kind:?} masks{masks:02x}"
            );
            assert_eq!(&actual.registers[1..], &before.registers[1..]);
            assert_eq!(
                actual.tag_word,
                if trapped {
                    before.tag_word
                } else {
                    (before.tag_word & !3) | 2
                }
            );
            assert_eq!(
                (
                    actual.instruction_pointer,
                    actual.data_pointer,
                    actual.opcode
                ),
                (0x1234, 0x5678, 0x345)
            );
            assert_eq!(effect.flags, 0xcd7);
            assert!(!effect.store && !effect.ax);
        }
    }
}

#[test]
fn unmasked_denormal_prevents_lower_precision_while_masked_denormal_can_post_precision() {
    for masks in 0..64 {
        let mut actual = state(ONE, 1, masks);
        let before = actual;
        eval(&mut actual, op(Kind::Add), 0, 0xcd7);
        let denormal_traps = masks & 2 == 0;
        let flags = if denormal_traps { 2 } else { 0x22 };
        let pending = flags & !masks != 0;
        assert_eq!(
            actual.status_word & STATUS,
            0x40 | flags | if pending { 0x8080 } else { 0 }
        );
        assert_eq!(actual.raw(0), ONE);
        assert_eq!(actual.tag_word, before.tag_word);
        assert_eq!(&actual.registers[1..], &before.registers[1..]);
    }
}

#[test]
fn empty_stack_priority_beats_nan_payloads_and_suppresses_or_commits_pop_by_invalid_mask() {
    for kind in [
        Kind::Add,
        Kind::Compare,
        Kind::CompareUnordered,
        Kind::CompareFlags,
        Kind::CompareUnorderedFlags,
    ] {
        for empty in 1..4 {
            for masked in [false, true] {
                let mut actual = state(
                    0x7fff8000000000000011,
                    0xffffc000000000000022,
                    if masked { 63 } else { 62 },
                );
                actual.status_word = 0x4700;
                if empty & 1 != 0 {
                    actual.set_tag(0, 3);
                }
                if empty & 2 != 0 {
                    actual.set_tag(1, 3);
                }
                let before = actual;
                let instruction = Op { pop: 1, ..op(kind) };
                let effect = eval(&mut actual, instruction, 0, 0xc92);
                assert_eq!(
                    actual.status_word & 0x80ff,
                    if masked { 0x41 } else { 0x80c1 }
                );
                assert_eq!(actual.top(), usize::from(masked));
                if !masked {
                    assert_eq!(actual.registers, before.registers);
                    assert_eq!(actual.tag_word, before.tag_word);
                }
                if matches!(kind, Kind::CompareFlags | Kind::CompareUnorderedFlags) {
                    assert_eq!(effect.flags, if masked { 0x447 } else { 0x402 });
                    assert_eq!(actual.status_word & 0x4500, 0x4500);
                } else {
                    assert_eq!(effect.flags, 0xc92);
                    if masked && kind != Kind::Add {
                        assert_eq!(actual.status_word & 0x4500, 0x4500);
                    }
                }
                if masked && kind == Kind::Add {
                    assert_eq!(actual.raw(0), INDEFINITE);
                }
            }
        }
    }
}

#[test]
fn push_stack_priority_preserves_all_payloads_when_unmasked_and_captures_sources_before_top_changes()
 {
    for top in 0..8 {
        for masked in [false, true] {
            let mut actual = State {
                control_word: if masked { 0x37f } else { 0x37e },
                status_word: (top << 11) | 0x200,
                ..State::default()
            };
            for bank in 0..8 {
                actual.set_raw(bank, ONE + bank as u128);
            }
            let target = (usize::from(top) + 7) & 7;
            actual.set_tag(target, 0);
            let before = actual;
            eval(
                &mut actual,
                Op {
                    kind: Kind::Load,
                    format: Format::F32,
                    ..Op::default()
                },
                0x7f800001,
                0xcd7,
            );
            assert_eq!(
                actual.status_word & 0x83ff,
                if masked { 0x241 } else { 0x82c1 }
            );
            assert_eq!(actual.top(), if masked { target } else { usize::from(top) });
            if masked {
                assert_eq!(actual.raw(target), INDEFINITE);
                assert_eq!(actual.tag(target), 2);
            } else {
                assert_eq!(actual.registers, before.registers);
                assert_eq!(actual.tag_word, before.tag_word);
            }
        }
    }
    let mut actual = state(ONE, 0xffff8000000000000011, 62);
    actual.status_word = 0;
    actual.set_tag(1, 3);
    actual.set_tag(7, 0);
    let before = actual;
    eval(
        &mut actual,
        Op {
            kind: Kind::Load,
            format: Format::Register,
            index: 1,
            ..Op::default()
        },
        0,
        0,
    );
    assert_eq!(actual.status_word & STATUS, 0x80c1);
    assert_eq!(actual.registers, before.registers);
    assert_eq!(actual.tag_word, before.tag_word);
}

#[test]
fn fxam_checks_empty_tags_then_raw_sign_and_class_without_raising_or_normalizing_payloads() {
    for (raw, tag, condition) in [
        (0, 1, 0x4000),
        (1u128 << 79, 1, 0x4200),
        (ONE, 0, 0x400),
        (ONE | (1 << 79), 0, 0x600),
        (1, 2, 0x4400),
        (1 | (1 << 79), 2, 0x4600),
        (0x00008000000000000000, 2, 0x4400),
        (0x7fff8000000000000000, 2, 0x500),
        (0xffff8000000000000000, 2, 0x700),
        (0x7fffc000000000000011, 2, 0x100),
        (0xffff8000000000000011, 2, 0x300),
        (0x3fff0000000000000001, 2, 0),
        (0xffff0000000000000011, 2, 0x200),
        (0xffff8000000000000011, 3, 0x4300),
        (ONE, 3, 0x4100),
    ] {
        let mut actual = state(raw, ONE, 63);
        actual.status_word = 0x477f;
        actual.set_tag(0, tag);
        let before = actual;
        eval(
            &mut actual,
            Op {
                kind: Kind::Examine,
                ..Op::default()
            },
            0,
            0xcd7,
        );
        assert_eq!(
            actual.status_word,
            0x7f | condition,
            "raw{raw:020x} tag{tag}"
        );
        assert_eq!(actual.registers, before.registers);
        assert_eq!(actual.tag_word, before.tag_word);
    }
}

#[test]
fn conditional_move_predicates_are_literal_truth_tables_and_nan_payloads_are_raw() {
    // Rows B, E, BE, U, NB, NE, NBE, NU; the bit index is CF | ZF<<1 | PF<<2.
    let truth = [0xaau8, 0xcc, 0xee, 0xf0, 0x55, 0x33, 0x11, 0x0f];
    let snan = 0xffff8000000000000033;
    for (condition, table) in truth.into_iter().enumerate() {
        for index in 0..8 {
            for top in 0..8 {
                let flags = 0xc92 | (index & 1) | ((index & 2) << 5) | (index & 4);
                let mut actual = State {
                    control_word: 0x37e,
                    status_word: (top << 11) | 0x200,
                    ..State::default()
                };
                let dst = usize::from(top);
                let src = (dst + 1) & 7;
                actual.set_raw(dst, ONE);
                actual.set_raw(src, snan);
                actual.set_tag(dst, 0);
                actual.set_tag(src, 2);
                let before = actual;
                let effect = eval(
                    &mut actual,
                    Op {
                        condition: condition as u8,
                        ..op(Kind::ConditionalMove)
                    },
                    0,
                    flags,
                );
                let taken = table & (1 << index) != 0;
                assert_eq!(actual.raw(dst), if taken { snan } else { ONE });
                assert_eq!(actual.tag(dst), if taken { 2 } else { 0 });
                for bank in 0..8 {
                    if bank != dst {
                        assert_eq!(actual.registers[bank], before.registers[bank]);
                    }
                }
                assert_eq!(
                    actual.tag_word & !(3 << (dst * 2)),
                    before.tag_word & !(3 << (dst * 2))
                );
                assert_eq!(actual.status_word, before.status_word);
                assert_eq!(effect.flags, flags);
            }
        }
    }
}

#[test]
fn conditional_move_empty_operand_checks_precede_every_predicate_and_preserve_unmasked_destinations()
 {
    for condition in 0..8 {
        for flags in [0x402, 0x447] {
            for empty in 1..4 {
                for masked in [false, true] {
                    let mut actual =
                        state(ONE, 0x7fff8000000000000033, if masked { 63 } else { 62 });
                    if empty & 1 != 0 {
                        actual.set_tag(0, 3);
                    }
                    if empty & 2 != 0 {
                        actual.set_tag(1, 3);
                    }
                    let before = actual;
                    let effect = eval(
                        &mut actual,
                        Op {
                            condition,
                            ..op(Kind::ConditionalMove)
                        },
                        0,
                        flags,
                    );
                    assert_eq!(
                        actual.status_word & STATUS,
                        if masked { 0x41 } else { 0x80c1 }
                    );
                    assert_eq!(actual.top(), 0);
                    assert_eq!(actual.raw(0), if masked { INDEFINITE } else { ONE });
                    assert_eq!(actual.tag(0), if masked { 2 } else { before.tag(0) });
                    assert_eq!(&actual.registers[1..], &before.registers[1..]);
                    assert_eq!(actual.tag_word & !3, before.tag_word & !3);
                    assert_eq!(effect.flags, flags);
                }
            }
        }
    }
}

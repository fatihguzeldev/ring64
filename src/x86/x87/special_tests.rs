use super::*;

fn occupied(values: &[u128], cw: u16) -> State {
    let mut state = State {
        control_word: cw,
        ..State::default()
    };
    for (i, &value) in values.iter().enumerate() {
        state.put(i, value);
    }
    state
}
fn operation(kind: Kind) -> Op {
    Op {
        kind,
        ..Op::default()
    }
}

#[test]
fn remainder_literals_use_fixed_st1_and_distinct_quotient_rounding() {
    for (kind, dividend, result, flags) in [
        (
            Kind::Remainder,
            0x4001e000000000000000,
            0x3fff8000000000000000,
            0x4200,
        ),
        (
            Kind::RemainderNearest,
            0x4001e000000000000000,
            0xbfff8000000000000000,
            0x100,
        ),
        (
            Kind::Remainder,
            0xc001e000000000000000,
            0xbfff8000000000000000,
            0x4200,
        ),
        (
            Kind::RemainderNearest,
            0xc001e000000000000000,
            0x3fff8000000000000000,
            0x100,
        ),
        (
            Kind::RemainderNearest,
            0x3fffc000000000000000,
            0xbffe8000000000000000,
            0x200,
        ),
    ] {
        for pc in [0, 1, 2, 3] {
            for rc in 0..4 {
                let mut state = occupied(
                    &[dividend, 0x40008000000000000000],
                    0x7f | pc << 8 | rc << 10,
                );
                eval(&mut state, operation(kind), 0, 2);
                assert_eq!(state.raw(0), result);
                assert_eq!(state.status_word & 0x7fff, flags);
                assert_eq!(state.raw(1), 0x40008000000000000000);
            }
        }
    }
}

#[test]
fn remainder_partial_step_is_single_bounded_n32_then_completes() {
    for kind in [Kind::Remainder, Kind::RemainderNearest] {
        let mut state = occupied(&[0x403f8000000000000002, 0x3fffc000000000000000], 0x37f);
        eval(&mut state, operation(kind), 0, 2);
        assert_eq!(state.raw(0), 0x401f8000000200000000);
        assert_eq!(state.status_word, 0x400);
        eval(&mut state, operation(kind), 0, 2);
        assert_eq!(state.raw(0), 0x3ffe8000000000000000);
        assert_eq!(state.status_word, 0x300);
    }
}

#[test]
fn scale_extract_and_decimal_literals_keep_full_precision_and_stack_roles() {
    let mut state = occupied(&[0x3fffc000000000000000, 0xbfffe000000000000000], 0x7f);
    eval(&mut state, operation(Kind::Scale), 0, 2);
    assert_eq!(state.raw(0), 0x3ffec000000000000000);
    assert_eq!(state.status_word, 0);
    let mut state = occupied(&[0x4002c000000000000000], 0x37f);
    eval(&mut state, operation(Kind::Extract), 0, 2);
    assert_eq!(state.raw(7), 0x3fffc000000000000000);
    assert_eq!(state.raw(0), 0x4000c000000000000000);
    assert_eq!(state.top(), 7);
    let mut state = State::default();
    eval(
        &mut state,
        Op {
            kind: Kind::Load,
            format: Format::Bcd,
            ..Op::default()
        },
        0x80123456789012345678,
        2,
    );
    assert_eq!(state.raw(7), 0xc037db4da5d31879a700);
    let mut state = occupied(&[0x3fffc000000000000000], 0x35f);
    let effect = eval(
        &mut state,
        Op {
            kind: Kind::Store,
            format: Format::Bcd,
            pop: 1,
            ..Op::default()
        },
        0,
        2,
    );
    assert_eq!(effect.value, 2);
    assert!(effect.store);
    assert_eq!(state.status_word, 0x8aa0);
    assert_eq!(state.tag_word, 0xffff);
}

#[test]
fn scale_tiny_massive_and_infinite_operands_preserve_exception_responses() {
    for (cw, source, scale, expected, status) in [
        (
            0x7f,
            0x3fff8000000000000001,
            0x3fff8000000000000000,
            0x40008000000000000001,
            0,
        ),
        (
            0x37f,
            0x00018000000000000000,
            0xbfff8000000000000000,
            0x00004000000000000000,
            0,
        ),
        (
            0x36f,
            0x00018000000000000000,
            0xbfff8000000000000000,
            0x60008000000000000000,
            0x8090,
        ),
        (
            0x377,
            0x3fff8000000000000000,
            0x7ffe8000000000000000,
            0x7fff8000000000000000,
            0x8088,
        ),
        (
            0x36f,
            0xbfff8000000000000000,
            0xfffe8000000000000000,
            0x80000000000000000000,
            0x8090,
        ),
        (
            0x37f,
            0xbfff8000000000000000,
            0x7fff8000000000000000,
            0xffff8000000000000000,
            0,
        ),
        (
            0x37f,
            0xbfff8000000000000000,
            0xffff8000000000000000,
            0x80000000000000000000,
            0,
        ),
        (0x37f, 0, 0x7fff8000000000000000, 0xffffc000000000000000, 1),
    ] {
        let mut state = occupied(&[source, scale], cw);
        eval(&mut state, operation(Kind::Scale), 0, 2);
        assert_eq!(state.raw(0), expected);
        assert_eq!(state.status_word, status);
        assert_eq!(state.raw(1), scale);
    }
}

#[test]
fn extract_masked_and_unmasked_stack_zero_and_denormal_cases_are_atomic() {
    for (empty, occupied_push, cw, wanted, top) in [
        (false, true, 0x37f, 0x3a41, 7),
        (true, true, 0x37f, 0x3841, 7),
        (false, true, 0x37e, 0x82c1, 0),
        (true, true, 0x37e, 0x80c1, 0),
    ] {
        let mut state = occupied(&[0x3fff8000000000000000], cw);
        if empty {
            state.set_tag(0, 3);
        }
        if occupied_push {
            state.put(7, 0x40008000000000000000);
        }
        let before = state;
        eval(&mut state, operation(Kind::Extract), 0, 2);
        assert_eq!(state.status_word, wanted);
        assert_eq!(state.top(), top);
        if cw & 1 == 0 {
            assert_eq!(state.registers, before.registers);
            assert_eq!(state.tag_word, before.tag_word);
        } else {
            assert_eq!(state.raw(0), 0xffffc000000000000000);
            assert_eq!(state.raw(7), 0xffffc000000000000000);
        }
    }
    for (cw, status, pushed) in [(0x37f, 0x3804, true), (0x37b, 0x8084, false)] {
        let mut state = occupied(&[0x80000000000000000000], cw);
        eval(&mut state, operation(Kind::Extract), 0, 2);
        assert_eq!(state.status_word & 0xbaff, status);
        assert_eq!(state.top(), if pushed { 7 } else { 0 });
        assert_eq!(
            state.raw(if pushed { 7 } else { 0 }),
            0x80000000000000000000
        );
        if pushed {
            assert_eq!(state.raw(0), 0xffff8000000000000000);
        }
    }
}

#[test]
fn bcd_rounds_before_range_check_and_never_posts_denormal() {
    for (raw, cw, result, status, store) in [
        (0x4000a000000000000000, 0x37f, 2, 0x820, true),
        (0x4000a000000000000000, 0x35f, 2, 0x88a0, true),
        (1, 0x37d, 0, 0x820, true),
        (
            0x7fff8000000000000000,
            0x37f,
            0xffffc000000000000000,
            0x801,
            true,
        ),
        (0x7fff8000000000000000, 0x37e, 0, 0x8081, false),
        (
            0x403ade0b6b3a763ffff8,
            0x37f,
            0xffffc000000000000000,
            0x801,
            true,
        ),
        (
            0x403ade0b6b3a763ffff8,
            0xf7f,
            0x999999999999999999,
            0x820,
            true,
        ),
    ] {
        let mut state = occupied(&[raw], cw);
        let effect = eval(
            &mut state,
            Op {
                kind: Kind::Store,
                format: Format::Bcd,
                pop: 1,
                ..Op::default()
            },
            0,
            2,
        );
        assert_eq!(effect.store, store);
        assert_eq!(effect.value, result);
        assert_eq!(state.status_word & 0xbaff, status);
        assert_eq!(state.top(), usize::from(store));
    }
}

#[test]
fn seeded_complete_remainders_match_independent_apfloat_and_converge() {
    use rustc_apfloat::{Float, ieee::X87DoubleExtended};
    let mut seed = 0x28a36e9d17830b21u64;
    let exponents = [-16382, -100, -1, 0, 1, 63, 64, 100, 16383];
    for sample in 0..256 {
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut operand = || {
            let sign = if next() & 1 != 0 { 1u128 << 79 } else { 0 };
            let exponent = exponents[next() as usize % exponents.len()];
            sign | (((exponent + 16383) as u128) << 64) | u128::from(next() | 1 << 63)
        };
        let a = operand();
        let b = operand();
        for kind in [Kind::Remainder, Kind::RemainderNearest] {
            let left = X87DoubleExtended::from_bits(a);
            let right = X87DoubleExtended::from_bits(b);
            let expected = if kind == Kind::Remainder {
                left.c_fmod(right)
            } else {
                left.ieee_rem(right)
            }
            .value
            .to_bits();
            let mut state = occupied(&[a, b], 0x7f | (sample % 4) << 8 | ((sample / 4) % 4) << 10);
            let mut steps = 0;
            loop {
                eval(&mut state, operation(kind), 0, 2);
                steps += 1;
                assert!(steps <= 1026, "bounded reduction {a:020x}/{b:020x}");
                if state.status_word & 0x400 == 0 {
                    break;
                }
            }
            assert_eq!(state.raw(0), expected, "{kind:?} {a:020x}/{b:020x}");
            assert_eq!(state.status_word & 0x20, 0);
            assert_eq!(state.raw(1), b);
        }
    }
}

#[test]
fn special_precondition_priority_and_all_masks_preserve_unmasked_destinations() {
    for kind in [Kind::Remainder, Kind::RemainderNearest, Kind::Scale] {
        let cases = if kind == Kind::Scale {
            vec![
                (0, 0x7fff8000000000000000, 1, 0xffffc000000000000000),
                (1, 0x400cfff8000000000000, 2, 0x3fc08000000000000000),
            ]
        } else {
            vec![
                (1, 0, 1, 0xffffc000000000000000),
                (0x7fff8000000000000000, 1, 1, 0xffffc000000000000000),
                (0, 1, 2, 0),
            ]
        };
        for (a, b, pre, result) in cases.into_iter().chain([
            (0x7fffc000000000000011, 1, 0, 0x7fffc000000000000011),
            (
                0x7fff8000000000000033,
                0x7fffc000000000000011,
                1,
                0x7fffc000000000000011,
            ),
            (
                0x3fff0000000000000001,
                0x3fff8000000000000000,
                1,
                0xffffc000000000000000,
            ),
        ]) {
            for masks in 0..64 {
                let mut state = occupied(&[a, b], 0x340 | masks);
                let before = state;
                eval(&mut state, operation(kind), 0, 0xcd7);
                let trapped = pre & !masks != 0;
                assert_eq!(
                    state.raw(0),
                    if trapped { a } else { result },
                    "{kind:?} masks{masks:x}"
                );
                assert_eq!(
                    state.status_word & 0xbaff,
                    pre | if trapped { 0x8080 } else { 0 }
                );
                assert_eq!(state.raw(1), b);
                if trapped {
                    assert_eq!(state.tag_word, before.tag_word);
                }
            }
        }
    }
}

#[test]
fn extract_and_decimal_stack_publication_cover_every_top_and_mask() {
    for top in 0..8 {
        for masks in 0..64 {
            for source_empty in [false, true] {
                for push_occupied in [false, true] {
                    let mut state = State {
                        control_word: 0x340 | masks,
                        status_word: (top as u16) << 11,
                        ..State::default()
                    };
                    if !source_empty {
                        state.put(top, 0x4002c000000000000000);
                    }
                    if push_occupied {
                        state.put((top + 7) & 7, 0x40008000000000000000);
                    }
                    let before = state;
                    eval(&mut state, operation(Kind::Extract), 0, 2);
                    let fault = source_empty || push_occupied;
                    let trapped = fault && masks & 1 == 0;
                    assert_eq!(state.top(), if trapped { top } else { (top + 7) & 7 });
                    if trapped {
                        assert_eq!(state.registers, before.registers);
                        assert_eq!(state.tag_word, before.tag_word);
                    } else if fault {
                        assert_eq!(state.raw(top), 0xffffc000000000000000);
                        assert_eq!(state.raw((top + 7) & 7), 0xffffc000000000000000);
                    } else {
                        assert_eq!(state.raw(top), 0x4000c000000000000000);
                        assert_eq!(state.raw((top + 7) & 7), 0x3fffc000000000000000);
                    }
                    assert_eq!(
                        state.status_word & 0x241,
                        if fault {
                            0x41 | if source_empty { 0 } else { 0x200 }
                        } else {
                            0
                        }
                    );
                }
            }
        }
    }
}

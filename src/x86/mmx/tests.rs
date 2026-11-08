use super::*;

fn state() -> x87::State {
    let mut state = x87::State {
        status_word: 5 << 11,
        tag_word: 0xe4e4,
        opcode: 0x5af,
        instruction_pointer: 0xfedcba9876543210,
        data_pointer: 0x123456789abcdef0,
        ..x87::State::default()
    };
    for i in 0..8 {
        state.set_raw(
            i,
            (0x1234u128 << 64) | (0x101010101010101u128 * (i as u128 + 1)),
        );
    }
    state
}

#[test]
fn register_moves_read_physical_banks_before_transition_and_empty_does_not_erase() {
    let mut s = state();
    let before = s;
    let op = Op {
        kind: Kind::Move,
        dst: 1,
        src: 0,
        ..Op::default()
    };
    let out = eval(&mut s, op, 0, 0, 0x1f80);
    assert_eq!(out.stage, None);
    assert_eq!(s.raw(1), 0xffff0101010101010101);
    assert_eq!(s.raw(0), before.raw(0));
    assert_eq!(s.raw(5), before.raw(5));
    assert_eq!(s.status_word, before.status_word & !0x3800);
    assert_eq!(s.tag_word, 0);
    let payloads = s.registers;
    eval(&mut s, Op::default(), 0, 0, 0x1f80);
    assert_eq!(s.tag_word, 0xffff);
    assert_eq!(s.top(), 0);
    assert_eq!(s.registers, payloads);
    assert_eq!(s.opcode, before.opcode);
    assert_eq!(s.instruction_pointer, before.instruction_pointer);
}

#[test]
fn pi_to_ps_literal_rounding_and_unmasked_precision_preserve_x87() {
    for (rc, low) in [
        (0, 0xcb8000004b800000u64),
        (1, 0xcb8000014b800000),
        (2, 0xcb8000004b800001),
        (3, 0xcb8000004b800000),
    ] {
        for unmasked in [false, true] {
            let mut s = state();
            s.set_raw(2, 0x1234feffffff01000001);
            let before = s;
            let old = 0x0123456789abcdef_8877665544332211u128;
            let csr = 0x1f80 | (rc << 13);
            let csr = if unmasked { csr & !0x1000 } else { csr };
            let out = eval(
                &mut s,
                Op {
                    kind: Kind::PiToPs,
                    dst: 15,
                    src: 2,
                    ..Op::default()
                },
                0,
                old,
                csr,
            );
            assert_eq!(out.mxcsr, csr | 0x20);
            if unmasked {
                assert_eq!(out.stage, Some(float::Stage::PostComputation));
                assert_eq!(s, before);
                assert_eq!(out.value, old);
            } else {
                assert_eq!(out.stage, None);
                assert_eq!(out.value, (old & !(u64::MAX as u128)) | low as u128);
                assert_eq!(s.tag_word, 0);
                assert_eq!(s.top(), 0);
            }
        }
    }
}

#[test]
fn pi_to_pd_memory_never_transitions_or_checks_pending() {
    let mut s = state();
    s.control_word = 0x37b;
    s.status_word = (5 << 11) | 0x8084;
    let before = s;
    let op = Op {
        kind: Kind::PiToPd,
        dst: 8,
        memory: true,
        ..Op::default()
    };
    assert!(!op.checks_pending());
    assert_eq!(op.memory_bytes(), 8);
    let out = eval(&mut s, op, 0xfffffffe00000001, 0, 0x1f80);
    assert_eq!(out.value, 0xc000000000000000_3ff0000000000000);
    assert_eq!(s, before);
}

#[test]
fn float_to_mmx_masked_and_unmasked_stage_publication_is_whole_instruction() {
    for (masks, stage, raised) in [
        (0x1f80, None, 0x21),
        (0x1f00, Some(float::Stage::PreComputation), 1),
        (0xf80, Some(float::Stage::PostComputation), 0x21),
    ] {
        let mut s = state();
        let before = s;
        let out = eval(
            &mut s,
            Op {
                kind: Kind::PsToPi,
                dst: 3,
                src: 15,
                ..Op::default()
            },
            0x7fc01234_7f800000_3fc00000_7fc12345,
            0,
            masks,
        );
        assert_eq!(out.stage, stage);
        assert_eq!(out.raised, raised);
        assert_eq!(out.mxcsr, masks | raised);
        if stage.is_none() {
            assert_eq!(s.raw(3), 0xffff0000000280000000);
            assert_eq!(s.tag_word, 0);
            assert_eq!(s.top(), 0);
        } else {
            assert_eq!(s, before);
        }
    }
}

#[test]
fn descriptor_rejects_malformed_shapes_and_roundtrips_selected_operations() {
    for c in 0..=255 {
        if let Some(kind) = kind(c) {
            let op = Op {
                kind,
                ..Op::default()
            };
            if op.well_formed() {
                assert_eq!(Op::try_decode(op.encode()), Some(op));
            }
        }
    }
    assert!(
        Op::try_decode(
            Op {
                kind: Kind::Store,
                ..Op::default()
            }
            .encode()
        )
        .is_none()
    );
    assert!(
        Op::try_decode(
            Op {
                kind: Kind::Empty,
                dst: 1,
                ..Op::default()
            }
            .encode()
        )
        .is_none()
    );
    assert!(
        Op::try_decode(
            Op {
                kind: Kind::Move,
                src: 9,
                ..Op::default()
            }
            .encode()
        )
        .is_none()
    );
    assert!(Op::try_decode(1 << 31).is_none());
}

#[test]
fn packed_literal_packets_use_the_64_bit_bank_halves_and_wrap_madd() {
    use VectorBinary as B;
    use Width::*;
    let packets: [(VectorBinary, u64, u64, u64); 13] = [
        (
            B::PackSigned(W16),
            0x0080007fff80ff7f,
            0x800000ff0000ffff,
            0x807f00ff7f7f8080,
        ),
        (
            B::PackSigned(W32),
            0x00008000ffff7fff,
            0x00007fffffff8000,
            0x7fff80007fff8000,
        ),
        (
            B::PackUnsignedWord,
            0xffff000100ff0100,
            0x7fff0080007f0000,
            0xff807f000001ffff,
        ),
        (
            B::UnpackHigh(W8),
            0x0102030405060708,
            0x1112131415161718,
            0x1101120213031404,
        ),
        (
            B::UnpackLow(W16),
            0x4444333322221111,
            0xddddccccbbbbaaaa,
            0xbbbb2222aaaa1111,
        ),
        (
            B::MaddSignedWord,
            0x8000800080008000,
            0x8000800080008000,
            0x8000000080000000,
        ),
        (
            B::MulHighWord { signed: true },
            0xffff800000027fff,
            0x0002000280000002,
            0xffffffffffff0000,
        ),
        (
            B::MulLowWord,
            0xffff800000027fff,
            0x0002000280000002,
            0xfffe00000000fffe,
        ),
        (
            B::MulUnsignedDword,
            0xdeadbeefffffffff,
            0xcafe0000ffffffff,
            0xfffffffe00000001,
        ),
        (B::SumAbsoluteByteDifferences, 0, u64::MAX, 0x7f8),
        (
            B::Average(W8),
            0xffff000080807f7f,
            0x0000ffff7f7f8080,
            0x8080808080808080,
        ),
        (
            B::SignedSaturatingAdd(W8),
            0x7f807f807f807f80,
            0x01ff01ff01ff01ff,
            0x7f807f807f807f80,
        ),
        (
            B::CompareGreater(W16),
            0x7fff80000001ffff,
            0x80007fffffff0001,
            0xffff0000ffff0000,
        ),
    ];
    for (kind, left, right, want) in packets {
        let mut s = state();
        s.set_raw(0, left as u128);
        s.set_raw(1, right as u128);
        let out = eval(
            &mut s,
            Op {
                kind: Kind::Binary(kind),
                dst: 0,
                src: 1,
                ..Op::default()
            },
            0,
            0,
            0x1f80,
        );
        assert_eq!(s.raw(0), (0xffffu128 << 64) | want as u128, "{kind:?}");
        assert_eq!(out.value, want as u128, "{kind:?}");
        assert_eq!(out.mxcsr, 0x1f80);
    }
}

#[test]
fn shifts_use_full_counts_and_zero_counts_still_install_mmx_state() {
    let packets: [(VectorShift, u64, u64, u64); 4] = [
        (VectorShift::Right(Width::W32), 1u64 << 32, u64::MAX, 0),
        (VectorShift::Left(Width::W64), 64, u64::MAX, 0),
        (
            VectorShift::ArithmeticRight(Width::W16),
            64,
            0x8000ffff7fff0001,
            0xffffffff00000000,
        ),
        (
            VectorShift::Right(Width::W64),
            0,
            0xfedcba9876543210,
            0xfedcba9876543210,
        ),
    ];
    for (kind, count, left, want) in packets {
        let mut s = state();
        s.set_raw(0, left as u128);
        s.set_raw(1, count as u128);
        eval(
            &mut s,
            Op {
                kind: Kind::Shift(kind),
                src: 1,
                ..Op::default()
            },
            0,
            0,
            0x1f80,
        );
        assert_eq!(s.raw(0), (0xffffu128 << 64) | want as u128);
        assert_eq!(s.top(), 0);
        assert_eq!(s.tag_word, 0);
    }
}

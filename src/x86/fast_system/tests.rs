use super::*;
use crate::memory::Access;
use crate::x86::context::{LoadedSegment, Mode, Segment, SegmentAttributes, SegmentType};
use crate::x86::flags;
use ControlFailure::{GeneralProtection, Undefined, Unsupported};

fn bank() -> State {
    State {
        star: 0x0020_0008_0000_0000,
        lstar: 0xffff_8000_0000_4000,
        fmask: 0x700,
        sysenter_cs: 0x1234_0008,
        sysenter_eip: 0xffff_8000_0000_5000,
        sysenter_esp: 0xffff_8000_0000_9000,
        kernel_gs_base: 0xffff_8000_0000_a000,
    }
}

fn paging(sce: bool) -> paging::State {
    paging::State {
        efer: if sce { 0xd01 } else { 0xd00 },
        ..paging::State::default()
    }
}

fn context(mode: Mode, cpl: u8) -> ExecutionContext {
    let mut context = ExecutionContext::default();
    context.set_mode_and_cpl(mode, cpl);
    for (segment, base) in [(Segment::Fs, 0x1234), (Segment::Gs, 0x5678)] {
        let mut cache = context.segment(segment);
        cache.base = base;
        context.set_segment(segment, 0x28, cache, context.attributes(segment));
    }
    context
}

fn scalar() -> state::State {
    let mut scalar = state::State {
        flags: 0x3c7fd7,
        rip: 0x400000,
        ..state::State::default()
    };
    for (index, register) in scalar.registers.iter_mut().enumerate() {
        *register = 0x1234_5678_0000_0000 | index as u64;
    }
    scalar.registers[4] = 0x0000_8000_0000_1234;
    scalar
}

fn assert_cache(context: &ExecutionContext, segment: Segment, selector: u16, wide: bool, cpl: u8) {
    assert_eq!(context.selector(segment), selector);
    assert_eq!(
        context.segment(segment),
        LoadedSegment {
            base: 0,
            limit: 0xffff_ffff,
            default32: segment == Segment::Ss || !wide,
            usable: true,
            kind: if segment == Segment::Cs {
                SegmentType::ReadableCode
            } else {
                SegmentType::ReadWrite
            },
        }
    );
    assert_eq!(
        context.attributes(segment),
        SegmentAttributes {
            dpl: cpl,
            present: true,
            conforming: false,
            accessed: true,
            long: segment == Segment::Cs && wide,
            granularity: true,
            available: false,
        }
    );
}

#[test]
fn normalized_bank_accepts_canonical_edges_and_rejects_reserved_or_wide_fields() {
    assert_eq!(State::default().validate(), Ok(()));
    assert_eq!(bank().validate(), Ok(()));
    for pointer in [0, 0x7fff_ffff_ffff, 0xffff_8000_0000_0000, u64::MAX] {
        for field in 0..4 {
            let mut candidate = bank();
            match field {
                0 => candidate.lstar = pointer,
                1 => candidate.sysenter_eip = pointer,
                2 => candidate.sysenter_esp = pointer,
                _ => candidate.kernel_gs_base = pointer,
            }
            assert_eq!(candidate.validate(), Ok(()), "{field} {pointer:x}");
        }
    }
    for pointer in [0x8000_0000_0000, 0xffff_7fff_ffff_ffff] {
        for field in 0..4 {
            let mut candidate = bank();
            match field {
                0 => candidate.lstar = pointer,
                1 => candidate.sysenter_eip = pointer,
                2 => candidate.sysenter_esp = pointer,
                _ => candidate.kernel_gs_base = pointer,
            }
            assert!(candidate.validate().is_err());
        }
    }
    for candidate in [
        State { star: 1, ..bank() },
        State {
            fmask: 1 << 32,
            ..bank()
        },
        State {
            sysenter_cs: 1 << 32,
            ..bank()
        },
    ] {
        assert!(candidate.validate().is_err());
    }
    assert_eq!(
        State {
            fmask: u32::MAX.into(),
            sysenter_cs: u32::MAX.into(),
            star: 0xffff_ffff_0000_0000,
            ..bank()
        }
        .validate(),
        Ok(())
    );
}

#[test]
fn selected_msr_readbacks_have_one_bank_or_loaded_segment_authority() {
    let mut context = context(Mode::Long64, 0);
    for (index, expected) in [
        (0xc0000081, 0x0020_0008_0000_0000),
        (0xc0000082, 0xffff_8000_0000_4000),
        (0xc0000084, 0x700),
        (0x174, 0x1234_0008),
        (0x175, 0xffff_8000_0000_9000),
        (0x176, 0xffff_8000_0000_5000),
        (0xc0000100, 0x1234),
        (0xc0000101, 0x5678),
        (0xc0000102, 0xffff_8000_0000_a000),
    ] {
        assert_eq!(bank().read_msr(index, &context), Ok(expected));
        context.set_mode_and_cpl(Mode::Compatibility, 0);
        assert_eq!(bank().read_msr(index, &context), Ok(expected));
        context.set_mode_and_cpl(Mode::Long64, 0);
    }
    for index in [0, 0xc0000080, 0xc0000083, u32::MAX] {
        assert_eq!(bank().read_msr(index, &context), Err(Unsupported));
        assert_eq!(
            bank().prepare_msr_write(index, 0, &context),
            Err(Unsupported)
        );
    }
}

#[test]
fn guest_msr_writes_apply_per_register_rules_without_touching_other_fields() {
    let context = context(Mode::Long64, 0);
    let original = bank();
    for (index, value, field) in [
        (0xc0000081, 0xfffc_0007_0000_0000, 0),
        (0xc0000082, u64::MAX, 1),
        (0xc0000084, 0xffff_ffff, 2),
        (0x174, 0xfeed_beef_1234_0008, 3),
        (0x176, 0x7fff_ffff_ffff, 4),
        (0x175, 0xffff_8000_0000_0000, 5),
        (0xc0000102, 0, 6),
    ] {
        let mut expected = original;
        match field {
            0 => expected.star = value,
            1 => expected.lstar = value,
            2 => expected.fmask = value,
            3 => expected.sysenter_cs = 0x1234_0008,
            4 => expected.sysenter_eip = value,
            5 => expected.sysenter_esp = value,
            _ => expected.kernel_gs_base = value,
        }
        assert_eq!(
            original.prepare_msr_write(index, value, &context),
            Ok((expected, context.clone()))
        );
    }
    for (index, value) in [
        (0xc0000081, 1),
        (0xc0000084, 1 << 32),
        (0xc0000082, 0x8000_0000_0000),
        (0x175, 0xffff_7fff_ffff_ffff),
        (0x176, 0x8000_0000_0000),
        (0xc0000102, 0x8000_0000_0000),
        (0xc0000100, 0x8000_0000_0000),
        (0xc0000101, 0x8000_0000_0000),
    ] {
        assert_eq!(
            original.prepare_msr_write(index, value, &context),
            Err(GeneralProtection)
        );
    }
    assert_eq!(original, bank());
}

#[test]
fn msr_privilege_precedes_index_and_value_while_other_profiles_stay_private() {
    for mode in [Mode::Long64, Mode::Compatibility] {
        for cpl in [1, 2, 3] {
            let context = context(mode, cpl);
            for index in [0xc0000081, 0xc0000100, 0xc0000080, 0xc0000083, u32::MAX] {
                assert_eq!(bank().read_msr(index, &context), Err(GeneralProtection));
                assert_eq!(
                    bank().prepare_msr_write(index, u64::MAX, &context),
                    Err(GeneralProtection)
                );
            }
        }
    }
    for mode in [Mode::Real, Mode::Protected, Mode::Virtual8086] {
        let context = context(mode, 0);
        assert_eq!(bank().read_msr(0xc0000081, &context), Err(Unsupported));
        assert_eq!(
            bank().prepare_msr_write(0xc0000081, 0, &context),
            Err(Unsupported)
        );
    }
}

#[test]
fn fs_gs_writes_preserve_cache_facts_and_compatibility_uses_only_the_effective_low32() {
    for (index, segment) in [(0xc0000100, Segment::Fs), (0xc0000101, Segment::Gs)] {
        let mut context = context(Mode::Compatibility, 0);
        let mut cache = context.segment(segment);
        cache.limit = 0x9000;
        context.set_segment(
            segment,
            0x2b,
            cache,
            SegmentAttributes {
                dpl: 3,
                available: true,
                ..context.attributes(segment)
            },
        );
        let before = context.clone();
        let (after_bank, after) = bank()
            .prepare_msr_write(index, 0xffff_8000_0000_1000, &context)
            .unwrap();
        assert_eq!(after_bank, bank());
        assert_eq!(after.selector(segment), before.selector(segment));
        assert_eq!(after.attributes(segment), before.attributes(segment));
        let mut expected_cache = before.segment(segment);
        expected_cache.base = 0xffff_8000_0000_1000;
        assert_eq!(after.segment(segment), expected_cache);
        assert_eq!(
            after.translate(0x20, 1, segment, Access::Read, false),
            Ok(0x1020)
        );
        assert_eq!(bank().read_msr(index, &after), Ok(0xffff_8000_0000_1000));
        assert_eq!(context, before);
    }
}

#[test]
fn syscall_captures_full_next_and_post_begin_flags_before_masking_without_using_the_stack() {
    let context = context(Mode::Long64, 3);
    let mut scalar = scalar();
    scalar.flags = 0x3d7fd7;
    let before = scalar.clone();
    let prepared = prepare(
        Instruction::Syscall,
        bank(),
        &paging(true),
        &scalar,
        &context,
        0x8000_0000_0000,
    )
    .unwrap();
    let mut expected = before.clone();
    expected.rip = 0xffff_8000_0000_4000;
    expected.registers[1] = 0x8000_0000_0000;
    expected.registers[11] = 0x3c7fd7;
    expected.flags = 0x3c78d7;
    assert_eq!(prepared.scalar, expected);
    assert_eq!(prepared.bank, bank());
    assert_eq!(prepared.context.mode(), Mode::Long64);
    assert_eq!(prepared.context.cpl(), 0);
    assert_cache(&prepared.context, Segment::Cs, 8, true, 0);
    assert_cache(&prepared.context, Segment::Ss, 16, true, 0);
    for segment in [Segment::Ds, Segment::Es, Segment::Fs, Segment::Gs] {
        assert_eq!(prepared.context.segment(segment), context.segment(segment));
        assert_eq!(
            prepared.context.attributes(segment),
            context.attributes(segment)
        );
        assert_eq!(
            prepared.context.selector(segment),
            context.selector(segment)
        );
    }
    assert_eq!(scalar, before);
}

#[test]
fn syscall_fmask_cannot_clear_fixed_bit_one_and_uses_the_unmasked_raw_ss_selector() {
    let bank = State {
        star: 0x0020_0009_0000_0000,
        fmask: 0xffff_ffff,
        ..bank()
    };
    let prepared = prepare(
        Instruction::Syscall,
        bank,
        &paging(true),
        &scalar(),
        &context(Mode::Long64, 0),
        0x400002,
    )
    .unwrap();
    assert_eq!(prepared.scalar.flags, 2);
    assert_eq!(prepared.scalar.registers[11], 0x3c7fd7);
    assert_cache(&prepared.context, Segment::Cs, 8, true, 0);
    assert_cache(&prepared.context, Segment::Ss, 17, true, 0);
}

#[test]
fn syscall_and_sysenter_admit_all_cpls_but_mode_and_sce_are_real_legality() {
    for cpl in 0..=3 {
        assert!(
            prepare(
                Instruction::Syscall,
                bank(),
                &paging(true),
                &scalar(),
                &context(Mode::Long64, cpl),
                4
            )
            .is_ok()
        );
        for mode in [Mode::Long64, Mode::Compatibility] {
            assert!(
                prepare(
                    Instruction::Sysenter,
                    bank(),
                    &paging(false),
                    &scalar(),
                    &context(mode, cpl),
                    4
                )
                .is_ok()
            );
        }
    }
    for instruction in [
        Instruction::Syscall,
        Instruction::Sysret { wide: true },
        Instruction::Sysret { wide: false },
        Instruction::Swapgs,
    ] {
        assert_eq!(
            prepare(
                instruction,
                bank(),
                &paging(true),
                &scalar(),
                &context(Mode::Compatibility, 3),
                4
            ),
            Err(Undefined)
        );
    }
    for instruction in [
        Instruction::Syscall,
        Instruction::Sysret { wide: true },
        Instruction::Sysret { wide: false },
    ] {
        assert_eq!(
            prepare(
                instruction,
                bank(),
                &paging(false),
                &scalar(),
                &context(Mode::Long64, 3),
                4
            ),
            Err(Undefined)
        );
    }
    for mode in [Mode::Real, Mode::Protected, Mode::Virtual8086] {
        for instruction in [
            Instruction::Syscall,
            Instruction::Sysenter,
            Instruction::Sysret { wide: false },
            Instruction::Sysexit { wide: false },
            Instruction::Swapgs,
        ] {
            assert_eq!(
                prepare(
                    instruction,
                    bank(),
                    &paging(true),
                    &scalar(),
                    &context(mode, 0),
                    4
                ),
                Err(Unsupported)
            );
        }
    }
}

#[test]
fn sysret_applies_its_own_flags_mask_and_preserves_rsp_and_unmentioned_segments() {
    let context = context(Mode::Long64, 0);
    let mut scalar = scalar();
    scalar.registers[1] = 0xffff_8000_0040_1234;
    scalar.registers[11] = u64::MAX;
    for (wide, pc, mode, cs) in [
        (false, 0x401234, Mode::Compatibility, 0x23),
        (true, 0xffff_8000_0040_1234, Mode::Long64, 0x33),
    ] {
        let prepared = prepare(
            Instruction::Sysret { wide },
            bank(),
            &paging(true),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        let mut expected = scalar.clone();
        expected.rip = pc;
        expected.flags = 0x3c7fd7;
        assert_eq!(prepared.scalar, expected);
        assert_eq!(prepared.context.mode(), mode);
        assert_eq!(prepared.context.cpl(), 3);
        assert_cache(&prepared.context, Segment::Cs, cs, wide, 3);
        assert_cache(&prepared.context, Segment::Ss, 0x2b, wide, 3);
        for segment in [Segment::Ds, Segment::Es, Segment::Fs, Segment::Gs] {
            assert_eq!(prepared.context.segment(segment), context.segment(segment));
            assert_eq!(
                prepared.context.attributes(segment),
                context.attributes(segment)
            );
            assert_eq!(
                prepared.context.selector(segment),
                context.selector(segment)
            );
        }
    }
}

#[test]
fn sysret64_denies_noncanonical_rcx_before_any_publication_but_32_discards_high_bits() {
    let context = context(Mode::Long64, 0);
    let mut scalar = scalar();
    scalar.registers[1] = 0x8000_0040_1234;
    let before = scalar.clone();
    assert_eq!(
        prepare(
            Instruction::Sysret { wide: true },
            bank(),
            &paging(true),
            &scalar,
            &context,
            4
        ),
        Err(GeneralProtection)
    );
    let prepared = prepare(
        Instruction::Sysret { wide: false },
        bank(),
        &paging(true),
        &scalar,
        &context,
        4,
    )
    .unwrap();
    assert_eq!(prepared.scalar.rip, 0x401234);
    assert_eq!(prepared.scalar.registers[4], 0x8000_0000_1234);
    assert_eq!(scalar, before);
}

#[test]
fn sysenter_uses_full_msr_pointers_from_both_submodes_and_saves_no_registers() {
    let scalar = scalar();
    for (mode, code32) in [
        (Mode::Long64, false),
        (Mode::Compatibility, false),
        (Mode::Compatibility, true),
    ] {
        let mut context = context(mode, 3);
        let mut cache = context.segment(Segment::Cs);
        cache.default32 = code32;
        context.set_segment(Segment::Cs, 0x1b, cache, context.attributes(Segment::Cs));
        let prepared = prepare(
            Instruction::Sysenter,
            bank(),
            &paging(false),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        let mut expected = scalar.clone();
        expected.rip = 0xffff_8000_0000_5000;
        expected.registers[4] = 0xffff_8000_0000_9000;
        expected.flags = 0x3c7dd7;
        assert_eq!(prepared.scalar, expected);
        assert_eq!(prepared.context.mode(), Mode::Long64);
        assert_eq!(prepared.context.cpl(), 0);
        assert_cache(&prepared.context, Segment::Cs, 8, true, 0);
        assert_cache(&prepared.context, Segment::Ss, 16, true, 0);
    }
}

#[test]
fn sysenter_family_preserves_ti_and_ignores_unused_cs_bits_during_wrapping() {
    let context = context(Mode::Long64, 0);
    let mut scalar = scalar();
    scalar.registers[1] = 0x8000;
    scalar.registers[2] = 0x400000;
    let bank = State {
        sysenter_cs: 0x1234_ffff,
        ..bank()
    };
    let entered = prepare(
        Instruction::Sysenter,
        bank,
        &paging(false),
        &scalar,
        &context,
        4,
    )
    .unwrap();
    assert_cache(&entered.context, Segment::Cs, 0xfffc, true, 0);
    assert_cache(&entered.context, Segment::Ss, 4, true, 0);
    for (wide, cs, ss) in [(false, 0xf, 0x17), (true, 0x1f, 0x27)] {
        let returned = prepare(
            Instruction::Sysexit { wide },
            bank,
            &paging(false),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        assert_cache(&returned.context, Segment::Cs, cs, wide, 3);
        assert_cache(&returned.context, Segment::Ss, ss, wide, 3);
    }
}

#[test]
fn sysexit_uses_rcx_for_stack_and_rdx_for_ip_with_explicit_zero_extension() {
    let context = context(Mode::Long64, 0);
    let mut scalar = scalar();
    scalar.registers[1] = 0xffff_8000_0000_8123;
    scalar.registers[2] = 0xffff_8000_0040_0456;
    for (wide, pc, sp, cs, ss, mode) in [
        (false, 0x400456, 0x8123, 0x1b, 0x23, Mode::Compatibility),
        (
            true,
            0xffff_8000_0040_0456,
            0xffff_8000_0000_8123,
            0x2b,
            0x33,
            Mode::Long64,
        ),
    ] {
        let prepared = prepare(
            Instruction::Sysexit { wide },
            bank(),
            &paging(false),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        let mut expected = scalar.clone();
        expected.rip = pc;
        expected.registers[4] = sp;
        assert_eq!(prepared.scalar, expected);
        assert_eq!(prepared.context.mode(), mode);
        assert_eq!(prepared.context.cpl(), 3);
        assert_cache(&prepared.context, Segment::Cs, cs, wide, 3);
        assert_cache(&prepared.context, Segment::Ss, ss, wide, 3);
    }
}

#[test]
fn sysexit_canonicality_and_null_selector_failures_are_atomic_and_form_specific() {
    let context = context(Mode::Long64, 0);
    for bad_register in [1, 2] {
        let mut scalar = scalar();
        scalar.registers[1] = 0x8000;
        scalar.registers[2] = 0x400000;
        scalar.registers[bad_register] |= 0x8000_0000_0000;
        let before = scalar.clone();
        assert_eq!(
            prepare(
                Instruction::Sysexit { wide: true },
                bank(),
                &paging(false),
                &scalar,
                &context,
                4
            ),
            Err(GeneralProtection)
        );
        let prepared = prepare(
            Instruction::Sysexit { wide: false },
            bank(),
            &paging(false),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        assert_eq!(prepared.scalar.rip, 0x400000);
        assert_eq!(prepared.scalar.registers[4], 0x8000);
        assert_eq!(scalar, before);
    }
    for selector in [0, 1, 2, 3, 0x1234_0000, 0xffff_0003] {
        let bank = State {
            sysenter_cs: selector,
            ..bank()
        };
        for instruction in [
            Instruction::Sysenter,
            Instruction::Sysexit { wide: true },
            Instruction::Sysexit { wide: false },
        ] {
            assert_eq!(
                prepare(instruction, bank, &paging(true), &scalar(), &context, 4),
                Err(GeneralProtection)
            );
        }
    }
}

#[test]
fn returns_and_swapgs_are_privileged_before_target_processing() {
    for cpl in [1, 2, 3] {
        let context = context(Mode::Long64, cpl);
        let mut scalar = scalar();
        scalar.registers[1] = 0x8000_0000_0000;
        scalar.registers[2] = 0x8000_0000_0000;
        for instruction in [
            Instruction::Sysret { wide: true },
            Instruction::Sysret { wide: false },
            Instruction::Sysexit { wide: true },
            Instruction::Sysexit { wide: false },
            Instruction::Swapgs,
        ] {
            assert_eq!(
                prepare(instruction, bank(), &paging(true), &scalar, &context, 4),
                Err(GeneralProtection)
            );
        }
    }
}

#[test]
fn zero_and_wrapping_star_selectors_are_real_loaded_caches_not_descriptor_loads() {
    let mut scalar = scalar();
    scalar.registers[1] = 0x400000;
    for (star, entry_cs, entry_ss, ret_cs, ret_ss) in [
        (0, 0, 8, 0x13, 0xb),
        (0xffff_fffc_0000_0000, 0xfffc, 4, 0xf, 7),
        (0x0004_0007_0000_0000, 4, 15, 0x17, 15),
    ] {
        let bank = State { star, ..bank() };
        let context = context(Mode::Long64, 0);
        let entry = prepare(
            Instruction::Syscall,
            bank,
            &paging(true),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        assert_cache(&entry.context, Segment::Cs, entry_cs, true, 0);
        assert_cache(&entry.context, Segment::Ss, entry_ss, true, 0);
        let returned = prepare(
            Instruction::Sysret { wide: true },
            bank,
            &paging(true),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        assert_cache(&returned.context, Segment::Cs, ret_cs, true, 3);
        assert_cache(&returned.context, Segment::Ss, ret_ss, true, 3);
    }
}

#[test]
fn swapgs_exchanges_the_actual_loaded_base_and_round_trips_without_other_effects() {
    let context = context(Mode::Long64, 0);
    let scalar = scalar();
    let prepared = prepare(
        Instruction::Swapgs,
        bank(),
        &paging(false),
        &scalar,
        &context,
        0x400003,
    )
    .unwrap();
    let mut expected = scalar.clone();
    expected.rip = 0x400003;
    assert_eq!(prepared.scalar, expected);
    assert_eq!(prepared.bank.kernel_gs_base, 0x5678);
    assert_eq!(
        prepared.context.segment(Segment::Gs).base,
        0xffff_8000_0000_a000
    );
    assert_eq!(
        prepared.context.selector(Segment::Gs),
        context.selector(Segment::Gs)
    );
    assert_eq!(
        prepared.context.attributes(Segment::Gs),
        context.attributes(Segment::Gs)
    );
    let restored = prepare(
        Instruction::Swapgs,
        prepared.bank,
        &paging(false),
        &prepared.scalar,
        &prepared.context,
        0x400006,
    )
    .unwrap();
    assert_eq!(restored.bank, bank());
    assert_eq!(restored.context, context);
    expected.rip = 0x400006;
    assert_eq!(restored.scalar, expected);
}

#[test]
fn flags_projections_supply_the_literal_tf_matrix_without_a_second_debug_owner() {
    let context = context(Mode::Long64, 0);
    for (incoming, fmask, expected) in [(0x102, 0x100, 2), (0x102, 0, 0x102), (2, 0x100, 2)] {
        let scalar = state::State {
            flags: incoming,
            ..scalar()
        };
        let bank = State { fmask, ..bank() };
        let prepared = prepare(
            Instruction::Syscall,
            bank,
            &paging(true),
            &scalar,
            &context,
            4,
        )
        .unwrap();
        assert_eq!(prepared.scalar.flags, expected);
    }
    for incoming in [2, 0x102] {
        for (restored, expected) in [(0, 2), (0x100, 0x102), (flags::RF | 0x100, 0x102)] {
            let mut scalar = state::State {
                flags: incoming,
                ..scalar()
            };
            scalar.registers[1] = 0x400000;
            scalar.registers[11] = restored;
            let prepared = prepare(
                Instruction::Sysret { wide: true },
                bank(),
                &paging(true),
                &scalar,
                &context,
                4,
            )
            .unwrap();
            assert_eq!(prepared.scalar.flags, expected);
        }
    }
}

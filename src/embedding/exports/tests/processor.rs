use super::super::processor::core_processor;
use super::*;
use crate::embedding::layout::PROTECTION;
use crate::x86::{
    context::Mode,
    processor::{TSC_AUX_MSR, TSC_MSR, TimeState},
};

fn time() -> TimeState {
    BRIDGE.with_borrow(|bridge| unsafe { (*bridge.core.as_ref().unwrap().state.get()).time })
}

fn scratch() -> [u8; 16] {
    BRIDGE.with_borrow(|bridge| unsafe {
        (*bridge.core.as_ref().unwrap().state.get()).vector_scratch
    })
}

fn prepare(paged: bool, cpl: u8, tsd: bool) {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.context.set_mode_and_cpl(Mode::Protected, cpl);
        if paged {
            core.physical_controls = true;
            core.paging = Some(crate::x86::paging::State {
                cr0: 0x11,
                cr4: if tsd { 4 } else { 0 },
                ..crate::x86::paging::State::reset()
            });
        }
        unsafe {
            let raw = &mut *core.state.get();
            raw.time = TimeState {
                tsc: 100,
                tsc_aux: 0x89abcdef,
            };
            raw.remaining = 999;
            raw.vector_scratch = [0xa5; 16];
        }
    });
}

#[test]
fn timestamp_bridge_uses_the_live_delta_without_settling_and_cpuid_ignores_tsd() {
    prepare(true, 0, true);
    assert_eq!(core_processor(2, 0, 0, 9), 0);
    assert_eq!(u64::from_le_bytes(scratch()[..8].try_into().unwrap()), 109);
    assert_eq!(
        u32::from_le_bytes(scratch()[8..12].try_into().unwrap()),
        0x89abcdef
    );
    assert_eq!(time().tsc, 100);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge
            .core
            .as_mut()
            .unwrap()
            .context
            .set_mode_and_cpl(Mode::Protected, 3)
    });
    let before = scratch();
    assert_eq!(core_processor(1, 0, 0, 9), PROTECTION);
    assert_eq!(scratch(), before);
    assert_eq!(time().tsc, 100);
    BRIDGE.with_borrow(|bridge| {
        assert_eq!(
            bridge
                .core
                .as_ref()
                .unwrap()
                .protection_fault
                .unwrap()
                .phase,
            crate::x86::protection::ProtectionPhase::Privilege
        )
    });
    assert_eq!(core_processor(0, 0, u32::MAX, 9), 0);
    let words: Vec<_> = scratch()
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    assert_eq!(words, [7, 0x676e6952, 0x656e6967, 0x6e453436]);
}

#[test]
fn time_msr_bridge_rebases_the_authoritative_bank_and_distinguishes_fault_phases() {
    prepare(true, 0, false);
    assert_eq!(paging::core_paging_control(2, TSC_MSR, 0, 0x1000, 2, 9), 0);
    assert_eq!(u64::from_le_bytes(scratch()[..8].try_into().unwrap()), 109);
    assert_eq!(
        paging::core_paging_control(3, TSC_MSR, u64::MAX, 0x1000, 2, 9),
        0
    );
    assert_eq!(time().tsc, u64::MAX - 10);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).time.settle(10)
    });
    assert_eq!(time().tsc, u64::MAX);
    let before = time();
    assert_eq!(
        paging::core_paging_control(3, TSC_AUX_MSR, 1 << 32, 0x1000, 2, 0),
        PROTECTION
    );
    assert_eq!(time(), before);
    BRIDGE.with_borrow(|bridge| {
        assert_eq!(
            bridge
                .core
                .as_ref()
                .unwrap()
                .protection_fault
                .unwrap()
                .phase,
            crate::x86::protection::ProtectionPhase::Target
        )
    });
    assert_eq!(
        paging::core_paging_control(3, TSC_AUX_MSR, 0x12345678, 0x1000, 2, 0),
        0
    );
    assert_eq!(time().tsc_aux, 0x12345678);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge
            .core
            .as_mut()
            .unwrap()
            .context
            .set_mode_and_cpl(Mode::Protected, 3)
    });
    assert_eq!(
        paging::core_paging_control(3, TSC_AUX_MSR, 1 << 32, 0x1000, 2, 0),
        PROTECTION
    );
    BRIDGE.with_borrow(|bridge| {
        assert_eq!(
            bridge
                .core
                .as_ref()
                .unwrap()
                .protection_fault
                .unwrap()
                .phase,
            crate::x86::protection::ProtectionPhase::Privilege
        )
    });
    prepare(false, 0, false);
    assert_eq!(
        paging::core_paging_control(2, TSC_MSR, 0, 0x1000, 2, 0),
        UNSUPPORTED
    );
}

#[test]
fn time_bank_is_appended_scalar_import_preserves_it_and_reset_zeros_it() {
    prepare(false, 0, false);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        let raw = &mut *bridge.core.as_mut().unwrap().state.get();
        raw.import(crate::x86::state::State::default());
    });
    assert_eq!(
        time(),
        TimeState {
            tsc: 100,
            tsc_aux: 0x89abcdef
        }
    );
    let descriptor = RunState::descriptor();
    assert_eq!(descriptor["time"]["offset"], 768);
    assert_eq!(descriptor["time"]["size"], 16);
    assert_eq!(descriptor["time"]["tsc"], 0);
    assert_eq!(descriptor["time"]["tscAux"], 8);
    assert_eq!(RunState::reset().time, TimeState::default());
}

#[test]
fn time_survives_context_epoch_saturation_prepare_and_owner_lifetimes() {
    fn compile() -> u64 {
        assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
        BRIDGE.with_borrow(|bridge| {
            let info: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
            u64::from_str_radix(info["owner"].as_str().unwrap().trim_start_matches("0x"), 16)
                .unwrap()
        })
    }
    for epoch in [0, u64::MAX - 1, u64::MAX] {
        prepare(false, 0, false);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            core.context_version = epoch;
            unsafe {
                (*core.state.get()).time = TimeState {
                    tsc: 0xffff_ffff_ffff_fffe,
                    tsc_aux: 0x89abcdef,
                };
                (*core.state.get()).remaining = u64::MAX;
            }
        });
        let before = time();
        assert_eq!(core_clear_fault(), 0);
        context::core_context_info();
        core_fault_info(DATA);
        assert_eq!(time(), before, "prepare/diagnostics epoch{epoch}");
        let installed = compile();
        assert_eq!(mapped::core_publish(installed), 1);
        let pending = compile();
        let original = BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().context.to_json());
        let mut changed = original.clone();
        changed["segments"]["fs"]["base"] = serde_json::json!("0x10000");
        for (index, value) in [changed, original].into_iter().enumerate() {
            BRIDGE.with_borrow_mut(|bridge| bridge.input = serde_json::to_vec(&value).unwrap());
            assert_eq!(context::core_set_context(), 0);
            assert_eq!(
                context::core_context_version(),
                epoch.saturating_add(index as u64 + 1)
            );
            assert_eq!(core_clear_fault(), 0);
            assert_eq!(time(), before, "context ABA epoch{epoch}");
        }
        assert_eq!(mapped::core_publish(pending), 0);
        assert_eq!(mapped::core_activate(installed), 1);
        mapped::core_release(installed);
        BRIDGE.with_borrow_mut(|bridge| bridge.core.as_mut().unwrap().retire_translations());
        assert_eq!(mapped::core_validity(installed), 0);
        assert_eq!(time(), before, "owner retirement epoch{epoch}");
    }
}

#[test]
fn tsd_only_guest_and_host_pae_changes_never_reload_the_unmapped_pdpt() {
    prepare(true, 0, false);
    let original = crate::x86::paging::State {
        cr0: 0x80000033,
        cr3: 0x8000,
        cr4: 0x628,
        efer: 0,
        pdpte: Some([0x3001, 0, 0, 0]),
        ..crate::x86::paging::State::reset()
    };
    BRIDGE.with_borrow_mut(|bridge| bridge.core.as_mut().unwrap().paging = Some(original));
    let before = time();
    let epoch = context::core_context_version();
    assert_eq!(paging::core_paging_control(1, 4, 0x62c, 0x1000, 2, 123), 0);
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        assert_eq!(core.paging.unwrap().pdpte, original.pdpte);
        assert_eq!(core.context_version, epoch);
    });
    assert_eq!(time(), before);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input = br#"{"cr0":"0x80000033","cr2":"0x0","cr3":"0x8000","cr4":"0x628","efer":"0x0","pdpte":["0x3001","0x0","0x0","0x0"]}"#.to_vec();
    });
    assert_eq!(paging::core_import_paging(), 0);
    assert_eq!(context::core_context_version(), epoch);
    assert_eq!(time(), before);
    // The same-root CR3 control proves a real reload cannot succeed in this image.
    assert_eq!(
        paging::core_paging_control(1, 3, 0x8000, 0x1000, 2, 123),
        25
    );
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        assert_eq!(core.paging, Some(original));
        assert_eq!(core.pdpte_load_fault.unwrap().1, 0);
    });
    assert_eq!(time(), before);
}

#[test]
fn time_msr_unknown_frontiers_and_privilege_rejection_keep_the_output_packet() {
    for index in [TSC_MSR, TSC_AUX_MSR, 0x11, 0xc0000104] {
        for write in [false, true] {
            prepare(true, 3, false);
            let before = (time(), scratch());
            assert_eq!(
                paging::core_paging_control(
                    if write { 3 } else { 2 },
                    index,
                    u64::MAX,
                    0x1000,
                    2,
                    123
                ),
                PROTECTION
            );
            assert_eq!((time(), scratch()), before);
            BRIDGE.with_borrow(|bridge| {
                assert_eq!(
                    bridge
                        .core
                        .as_ref()
                        .unwrap()
                        .protection_fault
                        .unwrap()
                        .phase,
                    crate::x86::protection::ProtectionPhase::Privilege
                );
            });
        }
    }
    for index in [0x11, 0xc0000104] {
        prepare(true, 0, false);
        let before = (time(), scratch());
        assert_eq!(
            paging::core_paging_control(2, index, 0, 0x1000, 2, 123),
            UNSUPPORTED
        );
        assert_eq!(
            paging::core_paging_control(3, index, u64::MAX, 0x1000, 2, 123),
            UNSUPPORTED
        );
        assert_eq!((time(), scratch()), before);
    }
}

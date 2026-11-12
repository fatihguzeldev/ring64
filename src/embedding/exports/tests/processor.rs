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
    assert_eq!(words, [1, 0x676e6952, 0x656e6967, 0x6e453436]);
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

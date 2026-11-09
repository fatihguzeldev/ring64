use super::super::system_flags::{core_debug_step, core_flags};
use super::*;
use crate::embedding::layout::{DEBUG_EXCEPTION, PROTECTION};
use crate::x86::instruction::{SystemFlagsDescriptor, SystemFlagsKind, Width};
use crate::x86::x87::State as X87State;

type Snapshot = (
    serde_json::Value,
    u64,
    Vec<u8>,
    [u64; 16],
    [u64; 7],
    [u32; 3],
    ([[u8; 16]; 16], [u8; 16], X87State),
);

fn snapshot() -> Snapshot {
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let s = unsafe { &*core.state.get() };
        (
            core.context.to_json(),
            core.context_version,
            core.image.read_bytes(0x4000, 16).unwrap(),
            s.registers,
            [
                s.flags,
                s.rip,
                s.remaining,
                s.target,
                s.repeat_remaining,
                u64::from(s.mxcsr),
                u64::from(s.x87.pending()),
            ],
            [s.fault_segment, s.interruptibility, s.mxcsr],
            (s.xmm, s.vector_scratch, s.x87),
        )
    })
}

fn descriptor(kind: SystemFlagsKind, width: Width) -> u32 {
    SystemFlagsDescriptor { kind, width }.encode()
}

fn poison_state() {
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        let s = &mut *bridge.core.as_mut().unwrap().state.get();
        s.registers = std::array::from_fn(|i| 0x1122334455660000 | i as u64);
        s.flags = 0x3d7fd7;
        s.rip = 0x1234;
        s.remaining = 17;
        s.repeat_remaining = 19;
        s.target = 0x5678;
        s.fault_segment = Segment::Fs as u32;
        s.interruptibility = 2;
        s.xmm = std::array::from_fn(|i| [i as u8 + 17; 16]);
        s.vector_scratch = [0xa5; 16];
        s.mxcsr = 0x1fa0;
        for i in 0..8 {
            s.x87.set_raw(i, (0xfff0_u128 << 64) | i as u128);
        }
    });
}

#[test]
fn malformed_flags_and_debug_helpers_preserve_complete_state_and_diagnostics() {
    initialize(0x1000, &[0x90]);
    poison_state();
    core_load(0x7000, 8);
    let fault = metadata(DATA);
    let before = snapshot();
    let push = descriptor(SystemFlagsKind::Push, Width::W64);
    for word in [
        12,
        13,
        14,
        15,
        16,
        u32::MAX,
        descriptor(SystemFlagsKind::Cli, Width::W64),
        descriptor(SystemFlagsKind::Push, Width::W32),
    ] {
        assert_eq!(core_flags(word, 2, u64::MAX), -1);
        assert_eq!(snapshot(), before);
        assert_eq!(metadata(DATA), fault);
    }
    let reserved = !(0x3d7fd7_u64);
    for flags in (0..64)
        .filter(|bit| reserved & (1 << bit) != 0)
        .map(|bit| 2 | (1 << bit))
        .chain([0, 1, 0x3d7fd5])
    {
        assert_eq!(core_flags(push, flags, 0), -1, "flags {flags:x}");
        assert_eq!(core_debug_step(0x1000, 0x1001, 1, flags), -1);
        assert_eq!(snapshot(), before);
        assert_eq!(metadata(DATA), fault);
    }
    for completed in [2, u32::MAX] {
        assert_eq!(core_debug_step(0x1000, 0x1001, completed, 2), -1);
        assert_eq!(snapshot(), before);
        assert_eq!(metadata(DATA), fault);
    }
}

#[test]
fn flags_helper_uses_live_input_and_publishes_only_low_scratch_word() {
    for (kind, flags, input, expected) in [
        (SystemFlagsKind::Push, 0x3d7fd7, 0, 0x3c7fd7_u64),
        (SystemFlagsKind::Pop, 0x190002, u64::MAX, 0x3c7fd7),
        (SystemFlagsKind::Cli, 0x180202, 0, 0x180002),
        (SystemFlagsKind::Sti, 0x180002, 0, 0x180202),
    ] {
        initialize(0x1000, &[0x90]);
        poison_state();
        let mut expected_state = snapshot();
        expected_state.6.1[..8].copy_from_slice(&expected.to_le_bytes());
        let width = if matches!(kind, SystemFlagsKind::Cli | SystemFlagsKind::Sti) {
            Width::W16
        } else {
            Width::W64
        };
        assert_eq!(core_flags(descriptor(kind, width), flags, input), 0);
        assert_eq!(snapshot(), expected_state);
    }
}

#[test]
fn v86_admission_reports_gp_without_observing_operand_or_changing_candidate() {
    for kind in [
        SystemFlagsKind::Push,
        SystemFlagsKind::Pop,
        SystemFlagsKind::Cli,
        SystemFlagsKind::Sti,
    ] {
        initialize(0x1000, &[0x90]);
        poison_state();
        BRIDGE.with_borrow_mut(|bridge| {
            bridge
                .core
                .as_mut()
                .unwrap()
                .context
                .set_mode_and_cpl(crate::x86::context::Mode::Virtual8086, 3);
        });
        let before = snapshot();
        let width = if matches!(kind, SystemFlagsKind::Cli | SystemFlagsKind::Sti) {
            Width::W16
        } else {
            Width::W32
        };
        assert_eq!(
            core_flags(descriptor(kind, width), 0x12002, u64::MAX),
            PROTECTION
        );
        assert_eq!(snapshot(), before);
        assert_eq!(
            metadata(PROTECTION),
            serde_json::json!({"vector":13,"errorCode":0,"phase":"privilege"})
        );
    }
}

#[test]
fn debug_report_forces_saved_partial_rf_without_modifying_live_banks() {
    for (v86, completed, expected) in [
        (false, 0, 0x10302),
        (false, 1, 0x302),
        (true, 0, 0x30302),
        (true, 1, 0x20302),
    ] {
        initialize(0x1000, &[0x90]);
        poison_state();
        if v86 {
            BRIDGE.with_borrow_mut(|bridge| {
                bridge
                    .core
                    .as_mut()
                    .unwrap()
                    .context
                    .set_mode_and_cpl(crate::x86::context::Mode::Virtual8086, 3);
            });
        }
        let mut before = snapshot();
        before.5[1] = 0;
        assert_eq!(
            core_debug_step(0x1000, 0x1000 + u64::from(completed), completed, 0x302),
            DEBUG_EXCEPTION
        );
        assert_eq!(snapshot(), before);
        assert_eq!(
            metadata(DEBUG_EXCEPTION),
            serde_json::json!({"vector":1,"class":"trap","cause":"single-step","instructionPc":"0x1000","resumePc":if completed==0{"0x1000"}else{"0x1001"},"instructionCompleted":completed==1,"resumeFlags":format!("0x{expected:x}")})
        );
    }
}

use super::super::software_events::core_software_event;
use super::*;
use crate::x86::context::Mode;

#[test]
fn malformed_event_arguments_preserve_banks_context_owners_and_diagnostics() {
    initialize(0x1000, &[0x90]);
    core_load(0x7000, 8);
    let before = BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let owner = core.image.register_source([(0x1000, 1)]).unwrap();
        assert!(core.image.activate(owner));
        let state = unsafe { &mut *core.state.get() };
        state.vector_scratch = [0xa5; 16];
        (
            core.context.to_json(),
            core.context_version,
            state.registers,
            state.flags,
            state.vector_scratch,
            core.image.read_bytes(0x4000, 16).unwrap(),
        )
    });
    let fault = metadata(DATA);
    for (operation, flags) in [
        (u32::MAX, 2),
        (0x20, 2),
        (0x10000, 2),
        (0x201, 2),
        (0x80, 2),
        (0x1c, 2),
        (0x1, 2),
        (0x402, 2),
        (0, 0),
        (0, 0x20002),
        (0, (1 << 40) | 2),
    ] {
        assert_eq!(core_software_event(operation, u64::MAX, flags, 0x1001), -1);
        assert_eq!(metadata(DATA), fault);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            let state = unsafe { &*core.state.get() };
            assert_eq!(
                (
                    core.context.to_json(),
                    core.context_version,
                    state.registers,
                    state.flags,
                    state.vector_scratch,
                    core.image.read_bytes(0x4000, 16).unwrap()
                ),
                before
            );
            assert!(core.image.owner_valid(1));
        });
    }
}

#[test]
fn event_bridge_uses_live_flags_and_sp_without_publishing_other_banks() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.context.set_mode_and_cpl(Mode::Real, 0);
        core.image
            .write_bytes(0x4000, &[0, 0x20, 0x34, 0x12, 2, 3])
            .unwrap();
        let state = unsafe { &mut *core.state.get() };
        state.registers = [0x1122334455667788; 16];
        state.flags = 0xcd7;
        state.remaining = 13;
        state.repeat_remaining = 17;
        state.xmm = [[0x5a; 16]; 16];
        state.mxcsr = 0xffc5;
    });
    assert_eq!(core_software_event(4, 0x4000, 2, 0x1001), 0);
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let state = unsafe { &*core.state.get() };
        assert_eq!(
            u64::from_le_bytes(state.vector_scratch[..8].try_into().unwrap()),
            0x2000
        );
        assert_eq!(
            u64::from_le_bytes(state.vector_scratch[8..].try_into().unwrap()),
            0x4006
        );
        assert_eq!(
            (
                state.flags,
                state.rip,
                state.remaining,
                state.repeat_remaining
            ),
            (0x302, 0x1000, 13, 17)
        );
        assert_eq!(state.registers, [0x1122334455667788; 16]);
        assert_eq!(state.xmm, [[0x5a; 16]; 16]);
        assert_eq!(state.mxcsr, 0xffc5);
        assert_eq!(core.context.selector(Segment::Cs), 0x1234);
        assert_eq!(core.context.segment(Segment::Cs).base, 0x12340);
    });
}

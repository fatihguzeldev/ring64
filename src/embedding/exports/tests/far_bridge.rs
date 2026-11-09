use super::*;
use crate::x86::instruction::{FarDescriptor, FarKind, Width};

#[test]
fn malformed_far_helper_arguments_preserve_context_memory_and_prior_diagnostics() {
    initialize(0x1000, &[0x90]);
    core_load(0x7000, 8);
    let before = BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        (
            core.context.to_json(),
            core.context_version,
            core.image.read_bytes(0x4000, 16).unwrap(),
            unsafe { (*core.state.get()).vector_scratch },
        )
    });
    let fault = metadata(DATA);
    let ret = FarDescriptor {
        kind: FarKind::Return,
        width: Width::W32,
        memory: false,
    }
    .encode();
    let mem = FarDescriptor {
        kind: FarKind::Jump,
        width: Width::W32,
        memory: true,
    }
    .encode();
    let direct = FarDescriptor {
        kind: FarKind::Jump,
        width: Width::W32,
        memory: false,
    }
    .encode();
    for (descriptor, operand, selector, segment) in [
        (u32::MAX, 0, 0, 1),
        (ret | 32, 0, 0, 1),
        (ret, 0x10000, 0, 1),
        (ret, 0, 1, 1),
        (ret, 0, 0, 6),
        (ret, 0, 0, 2),
        (mem, 0, 1, 2),
        (mem, 0, 0, u32::MAX),
        (direct, 0, 0x10000, 2),
        (direct, 0, 8, 2),
    ] {
        assert_eq!(
            far_control::core_far_control(descriptor, operand, selector, u64::MAX, 0x1000, segment),
            -1
        );
        assert_eq!(metadata(DATA), fault);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            assert_eq!(
                (
                    core.context.to_json(),
                    core.context_version,
                    core.image.read_bytes(0x4000, 16).unwrap(),
                    unsafe { (*core.state.get()).vector_scratch }
                ),
                before
            );
        });
    }
}

#[test]
fn far_transport_uses_live_sp_and_leaves_canonical_registers_for_generated_publication() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.context
            .set_mode_and_cpl(crate::x86::context::Mode::Real, 0);
        core.image.write_bytes(0x4000, &[0, 0x20, 0, 0]).unwrap();
        let owner = core.image.register_source([(0x1000, 1)]).unwrap();
        assert!(core.image.activate(owner));
        unsafe {
            let state = &mut *core.state.get();
            state.registers = [0x1122334455667788; 16];
            state.flags = 0xcd7;
            state.remaining = 13;
            state.repeat_remaining = 17;
            state.vector_scratch = [0xa5; 16];
        }
    });
    let descriptor = FarDescriptor {
        kind: FarKind::Return,
        width: Width::W16,
        memory: false,
    }
    .encode();
    assert_eq!(
        far_control::core_far_control(descriptor, 0, 0, 0x4000, 0x1001, Segment::Ss as u32),
        0
    );
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let state = unsafe { &*core.state.get() };
        assert_eq!(
            u64::from_le_bytes(state.vector_scratch[..8].try_into().unwrap()),
            0x2000
        );
        assert_eq!(
            u64::from_le_bytes(state.vector_scratch[8..].try_into().unwrap()),
            0x4004
        );
        assert_eq!(state.registers, [0x1122334455667788; 16]);
        assert_eq!(
            (
                state.rip,
                state.flags,
                state.remaining,
                state.repeat_remaining
            ),
            (0x1000, 0xcd7, 13, 17)
        );
        assert_eq!(core.context.selector(Segment::Cs), 0);
        assert_eq!(core.context_version, 1);
        assert!(!core.image.owner_valid(1));
    });
}

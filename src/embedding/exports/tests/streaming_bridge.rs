use super::*;
use crate::embedding::layout::X87_EXCEPTION;

fn prepare() {
    initialize(0x1000, &[0x90]);
    assert_eq!(core_load(0x7000, 8), 0);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        let core = bridge.core.as_mut().unwrap();
        let owner = core.image.register_source([(0x1000, 1)]).unwrap();
        assert!(core.image.activate(owner));
        core.divide_failed = true;
        let state = &mut *core.state.get();
        state.registers = [0x9988776655443322; 16];
        state.flags = 0xcd7;
        state.remaining = 17;
        state.repeat_remaining = 19;
        state.target = 0x800000000000;
        state.xmm = [[0x5a; 16]; 16];
        state.vector_scratch = [0xa5; 16];
        state.mxcsr = 0xffc5;
        state.x87.control_word = 0x37b;
        state.x87.status_word = 0xa884;
        state.x87.tag_word = 0x1234;
        state.x87.opcode = 0x345;
        state.x87.instruction_pointer = 0x123456789abcdef0;
        state.x87.data_pointer = 0xfedcba9876543210;
        for index in 0..8 {
            state.x87.set_raw(index, (0xabcdu128 << 64) | index as u128);
        }
    });
}

fn projection() -> serde_json::Value {
    BRIDGE.with_borrow(|bridge| unsafe {
        let core = bridge.core.as_ref().unwrap();
        let state = &*core.state.get();
        let x87 = state.x87;
        serde_json::json!({
            "registers":state.registers, "flags":state.flags, "rip":state.rip,
            "remaining":state.remaining, "repeat":state.repeat_remaining,
            "target":state.target, "segment":state.fault_segment,
            "xmm":state.xmm, "scratch":state.vector_scratch, "mxcsr":state.mxcsr,
            "x87": { "raw":x87.registers, "cw":x87.control_word, "sw":x87.status_word,
                "tw":x87.tag_word, "fop":x87.opcode, "fip":x87.instruction_pointer,
                "fdp":x87.data_pointer },
            "ram":core.image.read_bytes(0x4000,16).unwrap(),
            "owner":core.image.owner_valid(1), "activeChanged":core.image.active_changed(),
            "context":core.context.to_json(), "version":core.context_version,
            "divideFailed":core.divide_failed,
        })
    })
}

#[test]
fn malformed_masked_descriptors_preserve_state_memory_owners_and_pending_diagnostics() {
    prepare();
    let before = projection();
    let data_fault = metadata(DATA);
    let pending = metadata(X87_EXCEPTION);
    for (width, mask, segment) in [
        (0, 0, 2),
        (1, 0, 2),
        (4, 0, 2),
        (10, 0, 2),
        (32, 0, 2),
        (u32::MAX, 0, 2),
        (8, 1 << 8, 2),
        (8, u32::MAX, 2),
        (16, 1 << 16, 2),
        (16, u32::MAX, 2),
        (8, 0, 6),
        (16, 0, u32::MAX),
    ] {
        assert_eq!(
            streaming::core_masked_store(u64::MAX, width, u32::MAX, mask, segment),
            -1
        );
        assert_eq!(
            projection(),
            before,
            "width{width} mask{mask:x} segment{segment}"
        );
        assert_eq!(metadata(DATA), data_fault);
        assert_eq!(metadata(X87_EXCEPTION), pending);
    }
}

#[test]
fn malformed_clflush_segments_preserve_state_memory_owners_and_pending_diagnostics() {
    prepare();
    let before = projection();
    let data_fault = metadata(DATA);
    let pending = metadata(X87_EXCEPTION);
    for segment in [6, u32::MAX] {
        assert_eq!(streaming::core_clflush(u64::MAX, segment), -1);
        assert_eq!(projection(), before);
        assert_eq!(metadata(DATA), data_fault);
        assert_eq!(metadata(X87_EXCEPTION), pending);
    }
}

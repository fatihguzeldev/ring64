use super::*;
use crate::x86::x87::State as X87State;
use std::mem::{offset_of, size_of};

#[unsafe(no_mangle)]
pub extern "C" fn core_import_x87() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        if bridge.input.len() != 104 {
            return bridge.error("x87 state input length differs");
        }
        let word = |at| u16::from_le_bytes(bridge.input[at..at + 2].try_into().unwrap());
        let pointer = |at| u64::from_le_bytes(bridge.input[at..at + 8].try_into().unwrap());
        let state = X87State {
            registers: std::array::from_fn(|i| {
                let at = offset_of!(X87State, registers) + i * 10;
                bridge.input[at..at + 10].try_into().unwrap()
            }),
            control_word: word(offset_of!(X87State, control_word)),
            status_word: word(offset_of!(X87State, status_word)),
            tag_word: word(offset_of!(X87State, tag_word)),
            opcode: word(offset_of!(X87State, opcode)),
            instruction_pointer: pointer(offset_of!(X87State, instruction_pointer)),
            data_pointer: pointer(offset_of!(X87State, data_pointer)),
        };
        if state.opcode > 0x7ff {
            return bridge.error("x87 opcode exceeds eleven bits");
        }
        if let Err(message) = state.validate() {
            return bridge.error(message);
        }
        let core = bridge.core.as_mut().unwrap();
        unsafe {
            let transport = &mut *core.state.get();
            transport.x87 = state;
            transport.target = 0;
            transport.fault_segment = Segment::Cs as u32;
        }
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.divide_failed = false;
        0
    })
}

const _: () = assert!(size_of::<X87State>() == 104);

pub(super) fn exception_json(state: &X87State) -> Option<serde_json::Value> {
    (state.pending() != 0).then(|| {
        serde_json::json!({
            "vector": 16,
            "pending": state.pending(),
            "controlWord": state.control_word,
            "statusWord": state.status_word,
            "instructionPointer": format!("0x{:x}",state.instruction_pointer),
            "dataPointer": format!("0x{:x}",state.data_pointer),
            "opcode": state.opcode,
        })
    })
}

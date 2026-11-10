use super::*;
use crate::x86::debug::State;

#[unsafe(no_mangle)]
pub extern "C" fn core_import_debug() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        if bridge.input.len() != size_of::<State>() {
            return bridge.error("debug bank input length differs");
        }
        let word =
            |offset| u64::from_le_bytes(bridge.input[offset..offset + 8].try_into().unwrap());
        let mut input = State {
            addresses: std::array::from_fn(|i| word(i * 8)),
            dr6: word(32),
            dr7: word(40),
        };
        if input.dr6 > u32::MAX.into() || input.dr7 > u32::MAX.into() {
            return bridge.error("debug control input exceeds unsigned32");
        }
        input.normalize();
        unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).debug.registers = input;
        }
        0
    })
}

use crate::x86::state::State;

pub const DISPATCH: i32 = 0;
pub const BUDGET: i32 = 1;
pub const STOP: i32 = 2;
pub const UNSUPPORTED: i32 = 3;
pub const FETCH: i32 = 4;
pub const TARGET: i32 = 5;
pub const DATA: i32 = 6;
pub const INVALID: i32 = 7;
pub const RESOURCE: i32 = 8;
pub const DIVIDE_ERROR: i32 = 9;
pub const SEGMENT: i32 = 10;
pub const REPEAT_BUDGET: i32 = 11;
pub const ALIGNMENT: i32 = 12;
pub const SCALAR_STATE_SIZE: usize = 176;

pub const REASONS: [&str; 13] = [
    "dispatch",
    "budget",
    "stop",
    "unsupported",
    "fetch-fault",
    "target-fault",
    "data-fault",
    "invalid-encoding",
    "resource-limit",
    "divide-error",
    "segment-fault",
    "repeat-budget",
    "alignment-fault",
];

#[repr(C)]
pub struct RunState {
    pub registers: [u64; 16],
    pub flags: u64,
    pub rip: u64,
    pub remaining: u64,
    pub target: u64,
    pub fault_segment: u32,
    pub repeat_remaining: u64,
    pub xmm: [[u8; 16]; 16],
    pub vector_scratch: [u8; 16],
}

impl Default for RunState {
    fn default() -> Self {
        Self {
            registers: [0; 16],
            flags: 2,
            rip: 0,
            remaining: 0,
            target: 0,
            fault_segment: 0,
            repeat_remaining: 0,
            xmm: [[0; 16]; 16],
            vector_scratch: [0; 16],
        }
    }
}

impl RunState {
    pub fn import(&mut self, state: State) {
        self.registers = state.registers;
        self.flags = state.flags;
        self.rip = state.rip;
        self.remaining = 0;
        self.target = 0;
        self.fault_segment = 0;
        self.repeat_remaining = 0;
    }

    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({
            "size": size_of::<Self>(),
            "scalarSize": SCALAR_STATE_SIZE,
            "xmm": std::mem::offset_of!(Self, xmm),
            "xmmBytes": size_of::<[[u8; 16]; 16]>(),
            "vectorScratch": std::mem::offset_of!(Self, vector_scratch),
            "registers": std::mem::offset_of!(Self, registers),
            "flags": std::mem::offset_of!(Self, flags),
            "rip": std::mem::offset_of!(Self, rip),
            "remaining": std::mem::offset_of!(Self, remaining),
            "repeatRemaining": std::mem::offset_of!(Self, repeat_remaining),
            "faultSegment": std::mem::offset_of!(Self, fault_segment),
            "reasons": REASONS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xmm_banks_append_without_changing_scalar_import_or_legacy_offsets() {
        let mut state = RunState::default();
        assert_eq!(std::mem::offset_of!(RunState, xmm), 176);
        assert_eq!(std::mem::offset_of!(RunState, vector_scratch), 432);
        assert_eq!(size_of::<RunState>(), 448);
        assert_eq!(RunState::descriptor()["scalarSize"], 176);
        assert_eq!(RunState::descriptor()["xmmBytes"], 256);
        assert_eq!(state.xmm, [[0; 16]; 16]);
        state.xmm[15] = [0xff; 16];
        state.import(State::default());
        assert_eq!(state.xmm[15], [0xff; 16]);
    }

    #[test]
    fn repeated_work_extends_transport_after_existing_fields() {
        let descriptor = RunState::descriptor();
        assert_eq!(descriptor["size"], 448);
        assert_eq!(descriptor["repeatRemaining"], 168);
        assert_eq!(descriptor["reasons"][11], "repeat-budget");
    }

    #[test]
    fn divide_error_extends_the_controlled_reasons_without_moving_state() {
        assert_eq!(DIVIDE_ERROR, 9);
        assert_eq!(REASONS[DIVIDE_ERROR as usize], "divide-error");
        assert_eq!(
            &REASONS[..9],
            &[
                "dispatch",
                "budget",
                "stop",
                "unsupported",
                "fetch-fault",
                "target-fault",
                "data-fault",
                "invalid-encoding",
                "resource-limit",
            ]
        );
        assert_eq!(RunState::descriptor()["reasons"][9], "divide-error");
        assert_eq!(size_of::<RunState>(), 448);
    }

    #[test]
    fn runtime_target_transport_keeps_existing_state_offsets() {
        assert_eq!(std::mem::offset_of!(RunState, registers), 0);
        assert_eq!(std::mem::offset_of!(RunState, flags), 128);
        assert_eq!(std::mem::offset_of!(RunState, rip), 136);
        assert_eq!(std::mem::offset_of!(RunState, remaining), 144);
        assert_eq!(std::mem::offset_of!(RunState, target), 152);
        assert_eq!(std::mem::offset_of!(RunState, fault_segment), 160);
        assert_eq!(std::mem::offset_of!(RunState, repeat_remaining), 168);
        assert_eq!(size_of::<RunState>(), 448);
        assert_eq!(RunState::descriptor()["size"], 448);
    }

    #[test]
    fn architectural_import_resets_private_execution_transport() {
        let mut transport = RunState {
            remaining: 17,
            repeat_remaining: 23,
            target: 0x8000_0000_0008,
            ..RunState::default()
        };
        let registers = std::array::from_fn(|i| 0x1122_3344_0000_0000 + i as u64);
        transport.import(State {
            registers,
            flags: 0x8d7,
            rip: 0x1000,
        });
        assert_eq!(transport.registers, registers);
        assert_eq!(transport.flags, 0x8d7);
        assert_eq!(transport.rip, 0x1000);
        assert_eq!(transport.remaining, 0);
        assert_eq!(transport.repeat_remaining, 0);
        assert_eq!(transport.target, 0);
        assert_eq!(RunState::default().target, 0);
    }
}

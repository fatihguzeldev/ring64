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

pub const REASONS: [&str; 9] = [
    "dispatch",
    "budget",
    "stop",
    "unsupported",
    "fetch-fault",
    "target-fault",
    "data-fault",
    "invalid-encoding",
    "resource-limit",
];

#[repr(C)]
pub struct RunState {
    pub registers: [u64; 16],
    pub flags: u64,
    pub rip: u64,
    pub remaining: u64,
    pub target: u64,
}

impl Default for RunState {
    fn default() -> Self {
        Self {
            registers: [0; 16],
            flags: 2,
            rip: 0,
            remaining: 0,
            target: 0,
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
    }

    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({
            "size": size_of::<Self>(),
            "registers": std::mem::offset_of!(Self, registers),
            "flags": std::mem::offset_of!(Self, flags),
            "rip": std::mem::offset_of!(Self, rip),
            "remaining": std::mem::offset_of!(Self, remaining),
            "reasons": REASONS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_target_transport_keeps_existing_state_offsets() {
        assert_eq!(std::mem::offset_of!(RunState, registers), 0);
        assert_eq!(std::mem::offset_of!(RunState, flags), 128);
        assert_eq!(std::mem::offset_of!(RunState, rip), 136);
        assert_eq!(std::mem::offset_of!(RunState, remaining), 144);
        assert_eq!(std::mem::offset_of!(RunState, target), 152);
        assert_eq!(size_of::<RunState>(), 160);
        assert_eq!(RunState::descriptor()["size"], 160);
    }

    #[test]
    fn architectural_import_resets_private_execution_transport() {
        let mut transport = RunState {
            remaining: 17,
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
        assert_eq!(transport.target, 0);
        assert_eq!(RunState::default().target, 0);
    }
}

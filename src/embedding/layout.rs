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
}

impl Default for RunState {
    fn default() -> Self {
        Self {
            registers: [0; 16],
            flags: 2,
            rip: 0,
            remaining: 0,
        }
    }
}

impl RunState {
    pub fn import(&mut self, state: State) {
        self.registers = state.registers;
        self.flags = state.flags;
        self.rip = state.rip;
        self.remaining = 0;
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

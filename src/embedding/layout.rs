use crate::x86::exception::{
    EventState, ExceptionEvent, InterruptEvent, InterruptSource, InterruptState,
};
use crate::x86::state::State;
use crate::x86::x87::State as X87State;

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
pub const SIMD_EXCEPTION: i32 = 13;
pub const GENERAL_PROTECTION: i32 = 14;
pub const X87_EXCEPTION: i32 = 15;
pub const PROTECTION: i32 = 16;
pub const SYSTEM_MEMORY: i32 = 17;
pub const DEBUG_EXCEPTION: i32 = 18;
pub const EVENT_BUDGET: i32 = 19;
pub const PENDING_EXCEPTION: i32 = 20;
pub const SHUTDOWN: i32 = 21;
pub const PENDING_INTERRUPT: i32 = 22;
pub const HALTED: i32 = 23;
pub const SCALAR_STATE_SIZE: usize = 176;

pub const REASONS: [&str; 24] = [
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
    "simd-exception",
    "general-protection",
    "x87-exception",
    "protection-fault",
    "system-memory-fault",
    "debug-exception",
    "event-budget",
    "pending-exception",
    "shutdown",
    "pending-interrupt",
    "halted",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct RawEventState {
    pub kind: u32,
    pub vector: u32,
    pub instruction_pc: u64,
    pub return_pc: u64,
    pub saved_flags: u64,
    pub error_code: u32,
    pub has_error_code: u32,
}

impl RawEventState {
    pub fn decode(self) -> Result<EventState, &'static str> {
        match self.kind {
            0 if self == Self::default() => Ok(EventState::Ready),
            2 if self
                == (Self {
                    kind: 2,
                    ..Self::default()
                }) =>
            {
                Ok(EventState::Shutdown)
            }
            3 if self
                == (Self {
                    kind: 3,
                    ..Self::default()
                }) =>
            {
                Ok(EventState::Halted)
            }
            4 | 5
                if self.vector <= u8::MAX.into()
                    && (self.kind == 4 || self.vector == 2)
                    && self.instruction_pc == 0
                    && self.error_code == 0
                    && self.has_error_code == 0 =>
            {
                Ok(EventState::PendingInterrupt(InterruptEvent {
                    source: if self.kind == 4 {
                        InterruptSource::Irq(self.vector as u8)
                    } else {
                        InterruptSource::Nmi
                    },
                    return_pc: self.return_pc,
                    saved_flags: self.saved_flags,
                }))
            }
            1 if self.vector <= u8::MAX.into()
                && self.error_code <= u16::MAX.into()
                && self.has_error_code <= 1
                && (self.has_error_code != 0 || self.error_code == 0) =>
            {
                Ok(EventState::Pending(ExceptionEvent {
                    debug: None,
                    vector: self.vector as u8,
                    instruction_pc: self.instruction_pc,
                    return_pc: self.return_pc,
                    saved_flags: self.saved_flags,
                    error_code: (self.has_error_code != 0).then_some(self.error_code as u16),
                }))
            }
            _ => Err("invalid event state transport"),
        }
    }

    pub fn encode(event: EventState) -> Self {
        match event {
            EventState::Ready => Self::default(),
            EventState::Shutdown => Self {
                kind: 2,
                ..Self::default()
            },
            EventState::Halted => Self {
                kind: 3,
                ..Self::default()
            },
            EventState::PendingInterrupt(event) => Self {
                kind: if matches!(event.source, InterruptSource::Irq(_)) {
                    4
                } else {
                    5
                },
                vector: event.source.vector().into(),
                return_pc: event.return_pc,
                saved_flags: event.saved_flags,
                ..Self::default()
            },
            EventState::Pending(event) => Self {
                kind: 1,
                vector: event.vector.into(),
                instruction_pc: event.instruction_pc,
                return_pc: event.return_pc,
                saved_flags: event.saved_flags,
                error_code: event.error_code.unwrap_or(0).into(),
                has_error_code: event.error_code.is_some().into(),
            },
        }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != size_of::<Self>() {
            return Err("event input length differs");
        }
        let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        let wide = |offset| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
        Ok(Self {
            kind: word(0),
            vector: word(4),
            instruction_pc: wide(8),
            return_pc: wide(16),
            saved_flags: wide(24),
            error_code: word(32),
            has_error_code: word(36),
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct RawInterruptState {
    pub irq: u32,
    pub nmi_pending: u32,
    pub nmi_blocked: u32,
}

impl RawInterruptState {
    pub fn decode(self) -> Result<InterruptState, &'static str> {
        if self.irq > 256 || self.nmi_pending > 1 || self.nmi_blocked > 1 {
            return Err("invalid interrupt state transport");
        }
        Ok(InterruptState {
            irq: self.irq.checked_sub(1).map(|vector| vector as u8),
            nmi_pending: self.nmi_pending != 0,
            nmi_blocked: self.nmi_blocked != 0,
        })
    }

    pub fn encode(state: InterruptState) -> Self {
        Self {
            irq: state.irq.map_or(0, |vector| u32::from(vector) + 1),
            nmi_pending: state.nmi_pending.into(),
            nmi_blocked: state.nmi_blocked.into(),
        }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != size_of::<Self>() {
            return Err("interrupt input length differs");
        }
        let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        Ok(Self {
            irq: word(0),
            nmi_pending: word(4),
            nmi_blocked: word(8),
        })
    }
}

#[repr(C)]
pub struct RunState {
    pub registers: [u64; 16],
    pub flags: u64,
    pub rip: u64,
    pub remaining: u64,
    pub target: u64,
    pub fault_segment: u32,
    pub interruptibility: u32,
    pub repeat_remaining: u64,
    pub xmm: [[u8; 16]; 16],
    pub vector_scratch: [u8; 16],
    pub mxcsr: u32,
    pub x87: X87State,
    pub event: RawEventState,
    pub delivery_enabled: u32,
    pub interrupts: RawInterruptState,
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
            interruptibility: 0,
            repeat_remaining: 0,
            xmm: [[0; 16]; 16],
            vector_scratch: [0; 16],
            mxcsr: 0x1f80,
            x87: X87State::default(),
            event: RawEventState::default(),
            delivery_enabled: 0,
            interrupts: RawInterruptState::default(),
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
        self.interruptibility = 0;
        self.repeat_remaining = 0;
        self.event = RawEventState::default();
        self.interrupts = RawInterruptState::default();
    }

    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({
            "size": size_of::<Self>(),
            "scalarSize": SCALAR_STATE_SIZE,
            "xmm": std::mem::offset_of!(Self, xmm),
            "xmmBytes": size_of::<[[u8; 16]; 16]>(),
            "vectorScratch": std::mem::offset_of!(Self, vector_scratch),
            "mxcsr": std::mem::offset_of!(Self, mxcsr),
            "mxcsrBytes": size_of::<u32>(),
            "x87": {
                "offset": std::mem::offset_of!(Self, x87),
                "bytes": size_of::<X87State>(),
                "registers": std::mem::offset_of!(X87State, registers),
                "registerBytes": 10,
                "controlWord": std::mem::offset_of!(X87State, control_word),
                "statusWord": std::mem::offset_of!(X87State, status_word),
                "tagWord": std::mem::offset_of!(X87State, tag_word),
                "opcode": std::mem::offset_of!(X87State, opcode),
                "instructionPointer": std::mem::offset_of!(X87State, instruction_pointer),
                "dataPointer": std::mem::offset_of!(X87State, data_pointer),
            },
            "event": {
                "offset": std::mem::offset_of!(Self, event),
                "bytes": size_of::<RawEventState>(),
                "kind": std::mem::offset_of!(RawEventState, kind),
                "vector": std::mem::offset_of!(RawEventState, vector),
                "instructionPc": std::mem::offset_of!(RawEventState, instruction_pc),
                "returnPc": std::mem::offset_of!(RawEventState, return_pc),
                "savedFlags": std::mem::offset_of!(RawEventState, saved_flags),
                "errorCode": std::mem::offset_of!(RawEventState, error_code),
                "hasErrorCode": std::mem::offset_of!(RawEventState, has_error_code),
            },
            "deliveryEnabled": std::mem::offset_of!(Self, delivery_enabled),
            "interrupts": {
                "offset": std::mem::offset_of!(Self, interrupts),
                "bytes": size_of::<RawInterruptState>(),
                "irq": std::mem::offset_of!(RawInterruptState, irq),
                "nmiPending": std::mem::offset_of!(RawInterruptState, nmi_pending),
                "nmiBlocked": std::mem::offset_of!(RawInterruptState, nmi_blocked),
            },
            "registers": std::mem::offset_of!(Self, registers),
            "flags": std::mem::offset_of!(Self, flags),
            "rip": std::mem::offset_of!(Self, rip),
            "remaining": std::mem::offset_of!(Self, remaining),
            "repeatRemaining": std::mem::offset_of!(Self, repeat_remaining),
            "faultSegment": std::mem::offset_of!(Self, fault_segment),
            "interruptibility": std::mem::offset_of!(Self, interruptibility),
            "interruptibilityBytes": size_of::<u32>(),
            "reasons": REASONS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interruptibility_uses_scalar_padding_without_moving_any_numeric_state() {
        assert_eq!(std::mem::offset_of!(RunState, interruptibility), 164);
        assert_eq!(std::mem::offset_of!(RunState, repeat_remaining), 168);
        assert_eq!(std::mem::offset_of!(RunState, xmm), 176);
        assert_eq!(size_of::<RunState>(), 616);
        assert_eq!(REASONS[18], "debug-exception");
        assert_eq!(RunState::descriptor()["interruptibilityBytes"], 4);
        let mut state = RunState {
            interruptibility: 2,
            ..RunState::default()
        };
        state.import(State::default());
        assert_eq!(state.interruptibility, 0);
    }

    #[test]
    fn x87_projection_appends_after_mxcsr_and_scalar_import_preserves_pending_and_ghosts() {
        let mut transport = RunState::default();
        assert_eq!(std::mem::offset_of!(RunState, mxcsr), 448);
        assert_eq!(std::mem::offset_of!(RunState, x87), 456);
        assert_eq!(size_of::<RunState>(), 616);
        let projection = &RunState::descriptor()["x87"];
        assert_eq!(projection["bytes"], 104);
        assert_eq!(projection["controlWord"], 80);
        assert_eq!(projection["instructionPointer"], 88);
        transport.x87.registers[7] = [0xa5; 10];
        transport.x87.control_word = 0x37b;
        transport.x87.status_word = 0xa884;
        let before = transport.x87;
        transport.import(State::default());
        assert_eq!(transport.x87, before);
        assert_eq!(REASONS[X87_EXCEPTION as usize], "x87-exception");
    }

    #[test]
    fn xmm_banks_append_without_changing_scalar_import_or_legacy_offsets() {
        let mut state = RunState::default();
        assert_eq!(std::mem::offset_of!(RunState, xmm), 176);
        assert_eq!(std::mem::offset_of!(RunState, vector_scratch), 432);
        assert_eq!(size_of::<RunState>(), 616);
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
        assert_eq!(descriptor["size"], 616);
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
        assert_eq!(size_of::<RunState>(), 616);
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
        assert_eq!(size_of::<RunState>(), 616);
        assert_eq!(RunState::descriptor()["size"], 616);
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

    #[test]
    fn external_transport_keeps_source_identity_and_rejects_noncanonical_payloads() {
        let irq = RawEventState {
            kind: 4,
            vector: 13,
            return_pc: 0x1000,
            saved_flags: 0x202,
            ..RawEventState::default()
        };
        assert_eq!(
            irq.decode().unwrap(),
            EventState::PendingInterrupt(InterruptEvent {
                source: InterruptSource::Irq(13),
                return_pc: 0x1000,
                saved_flags: 0x202,
            })
        );
        for raw in [
            RawEventState {
                kind: 5,
                vector: 2,
                ..irq
            },
            RawEventState {
                kind: 3,
                ..RawEventState::default()
            },
        ] {
            assert_eq!(RawEventState::encode(raw.decode().unwrap()), raw);
        }
        for raw in [
            RawEventState {
                instruction_pc: 1,
                ..irq
            },
            RawEventState {
                has_error_code: 1,
                ..irq
            },
            RawEventState {
                error_code: 1,
                ..irq
            },
            RawEventState { vector: 256, ..irq },
            RawEventState { kind: 5, ..irq },
            RawEventState { kind: 3, ..irq },
        ] {
            assert!(raw.decode().is_err(), "{raw:?}");
        }
        let interrupts = RawInterruptState {
            irq: 256,
            nmi_pending: 1,
            nmi_blocked: 1,
        };
        assert_eq!(
            interrupts.decode().unwrap(),
            InterruptState {
                irq: Some(255),
                nmi_pending: true,
                nmi_blocked: true
            }
        );
        assert_eq!(
            RawInterruptState::encode(interrupts.decode().unwrap()),
            interrupts
        );
        assert!(
            RawInterruptState {
                irq: 257,
                ..interrupts
            }
            .decode()
            .is_err()
        );
        assert!(
            RawInterruptState {
                nmi_pending: 2,
                ..interrupts
            }
            .decode()
            .is_err()
        );
        assert!(
            RawInterruptState {
                nmi_blocked: 2,
                ..interrupts
            }
            .decode()
            .is_err()
        );
    }
}

use super::context::ExecutionContext;
use super::flags;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExceptionEvent {
    pub vector: u8,
    pub instruction_pc: u64,
    pub return_pc: u64,
    pub saved_flags: u64,
    pub error_code: Option<u16>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EventState {
    #[default]
    Ready,
    Pending(ExceptionEvent),
    Shutdown,
}

impl ExceptionEvent {
    pub fn validate(
        self,
        rip: u64,
        live_flags: u64,
        context: &ExecutionContext,
    ) -> Result<(), &'static str> {
        let valid_code = match self.vector {
            0 | 1 | 6 | 16 | 19 => self.error_code.is_none(),
            8 => self.error_code == Some(0),
            10..=13 => self.error_code.is_some(),
            _ => false,
        };
        if !valid_code {
            return Err("invalid exception vector or error code");
        }
        if self.return_pc != rip {
            return Err("pending exception return pc differs from rip");
        }
        if self.saved_flags & !(flags::IMPORTED_MASK | flags::VM) != 0
            || self.saved_flags & 2 == 0
            || live_flags & !flags::IMPORTED_MASK != 0
            || live_flags & 2 == 0
        {
            return Err("invalid pending exception flags");
        }
        let architectural = flags::architectural(live_flags, context);
        if (self.saved_flags ^ architectural) & !flags::RF != 0 {
            return Err("pending exception flags differ from live flags");
        }
        if self.vector != 1 && self.saved_flags & flags::RF == 0 {
            return Err("fault image requires rf");
        }
        Ok(())
    }

    pub fn fault(
        vector: u8,
        pc: u64,
        live_flags: u64,
        context: &ExecutionContext,
        error_code: Option<u16>,
    ) -> Self {
        Self {
            vector,
            instruction_pc: pc,
            return_pc: pc,
            saved_flags: flags::architectural(live_flags, context) | flags::RF,
            error_code,
        }
    }

    pub fn escalate(self, vector: u8, error_code: u16) -> EventState {
        assert!(matches!(vector, 10..=13), "selected entry protection fault");
        if self.vector == 8 {
            return EventState::Shutdown;
        }
        let double_fault = matches!(self.vector, 0 | 10..=13);
        EventState::Pending(Self {
            vector: if double_fault { 8 } else { vector },
            error_code: Some(if double_fault { 0 } else { error_code }),
            saved_flags: self.saved_flags | flags::RF,
            ..self
        })
    }
}

impl EventState {
    pub fn validate(
        self,
        rip: u64,
        live_flags: u64,
        context: &ExecutionContext,
    ) -> Result<(), &'static str> {
        match self {
            Self::Pending(event) => event.validate(rip, live_flags, context),
            Self::Ready | Self::Shutdown => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::x86::context::ExecutionContext;
    use crate::x86::flags;

    #[test]
    fn exception_checkpoint_validates_boundary_flags_vm_and_error_code_together() {
        let context = ExecutionContext::default();
        let event = ExceptionEvent::fault(13, 0x1000, 0x202, &context, Some(0));
        assert_eq!(event.saved_flags, 0x10202);
        assert!(event.validate(0x1000, 0x202, &context).is_ok());
        for changed in [
            ExceptionEvent {
                vector: 14,
                ..event
            },
            ExceptionEvent {
                return_pc: 0x1001,
                ..event
            },
            ExceptionEvent {
                saved_flags: 0x202,
                ..event
            },
            ExceptionEvent {
                saved_flags: 0x10203,
                ..event
            },
            ExceptionEvent {
                saved_flags: 0x30202,
                ..event
            },
            ExceptionEvent {
                saved_flags: 0x10200,
                ..event
            },
            ExceptionEvent {
                saved_flags: 1 << 63 | 0x10202,
                ..event
            },
            ExceptionEvent {
                error_code: None,
                ..event
            },
        ] {
            assert!(
                changed.validate(0x1000, 0x202, &context).is_err(),
                "{changed:?}"
            );
        }
        let mut virtual_context = context.to_json();
        virtual_context["mode"] = serde_json::json!("virtual8086");
        virtual_context["cpl"] = serde_json::json!(3);
        for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
            virtual_context["segments"][name]["selector"] = serde_json::json!(0);
            virtual_context["segments"][name]["base"] = serde_json::json!("0x0");
            virtual_context["segments"][name]["limit"] = serde_json::json!(0xffff);
            virtual_context["segments"][name]["type"] = serde_json::json!("read-write");
            virtual_context["segments"][name]["default32"] = serde_json::json!(false);
        }
        let virtual_context = ExecutionContext::from_json(&virtual_context).unwrap();
        let vm = ExceptionEvent::fault(0, 0x1000, 2, &virtual_context, None);
        assert_eq!(vm.saved_flags, 0x30002);
        assert!(vm.validate(0x1000, 2, &virtual_context).is_ok());
        assert!(vm.validate(0x1000, 2, &context).is_err());
    }

    #[test]
    fn selected_vectors_have_one_error_code_and_fault_or_trap_authority() {
        let context = ExecutionContext::default();
        for vector in [0, 1, 6, 8, 10, 11, 12, 13, 16, 19] {
            let error_code = matches!(vector, 8 | 10..=13).then_some(0);
            let event = ExceptionEvent::fault(vector, 0x1000, flags::TF | 2, &context, error_code);
            assert!(event.validate(0x1000, flags::TF | 2, &context).is_ok());
            assert!(
                ExceptionEvent {
                    error_code: if error_code.is_some() { None } else { Some(0) },
                    ..event
                }
                .validate(0x1000, flags::TF | 2, &context)
                .is_err()
            );
            let without_rf = ExceptionEvent {
                saved_flags: flags::TF | 2,
                ..event
            };
            assert_eq!(
                without_rf.validate(0x1000, flags::TF | 2, &context).is_ok(),
                vector == 1
            );
        }
        let df = ExceptionEvent::fault(8, 0x1000, 2, &context, Some(1));
        assert!(df.validate(0x1000, 2, &context).is_err());
        assert!(EventState::Ready.validate(0x1000, 2, &context).is_ok());
        assert!(EventState::Shutdown.validate(0x1000, 2, &context).is_ok());
    }

    #[test]
    fn escalation_distinguishes_benign_contributory_and_double_fault_entry() {
        let context = ExecutionContext::default();
        for vector in [1, 6, 16, 19, 0, 10, 11, 12, 13, 8] {
            let event = ExceptionEvent {
                vector,
                instruction_pc: 0x1000,
                return_pc: 0x1010,
                saved_flags: 0x302,
                error_code: None,
            };
            for secondary in [10, 11, 12, 13] {
                let result = event.escalate(secondary, 0x2b);
                if vector == 8 {
                    assert_eq!(result, EventState::Shutdown);
                    continue;
                }
                let EventState::Pending(next) = result else {
                    panic!("{vector}")
                };
                assert_eq!(
                    next.vector,
                    if matches!(vector, 0 | 10..=13) {
                        8
                    } else {
                        secondary
                    }
                );
                assert_eq!(
                    next.error_code,
                    Some(if next.vector == 8 { 0 } else { 0x2b })
                );
                assert_eq!(
                    (next.instruction_pc, next.return_pc, next.saved_flags),
                    (0x1000, 0x1010, 0x10302)
                );
                assert!(next.validate(0x1010, 0x302, &context).is_ok());
            }
        }
    }
}

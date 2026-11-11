use super::context::{ExecutionContext, Mode};
use super::flags;
use super::protection::{ProtectionFault, ProtectionPhase};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExceptionEvent {
    pub numeric: Option<super::numeric_controls::Fault>,
    pub debug: Option<super::debug::Source>,
    pub vector: u8,
    pub instruction_pc: u64,
    pub return_pc: u64,
    pub saved_flags: u64,
    pub error_code: Option<u16>,
    pub page_fault_address: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterruptSource {
    Irq(u8),
    Nmi,
}

impl InterruptSource {
    pub fn vector(self) -> u8 {
        match self {
            Self::Irq(vector) => vector,
            Self::Nmi => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InterruptEvent {
    pub source: InterruptSource,
    pub return_pc: u64,
    pub saved_flags: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InterruptState {
    pub irq: Option<u8>,
    pub nmi_pending: bool,
    pub nmi_blocked: bool,
}

impl InterruptState {
    pub fn eligible(self, live_flags: u64, shadow: u32) -> Option<InterruptSource> {
        if self.nmi_pending && !self.nmi_blocked && shadow != 2 {
            Some(InterruptSource::Nmi)
        } else if live_flags & flags::IF != 0 && shadow == 0 {
            self.irq.map(InterruptSource::Irq)
        } else {
            None
        }
    }

    pub fn accept(
        &mut self,
        pc: u64,
        live_flags: u64,
        context: &ExecutionContext,
        shadow: u32,
    ) -> Option<InterruptEvent> {
        let source = self.eligible(live_flags, shadow)?;
        match source {
            InterruptSource::Irq(_) => self.irq = None,
            InterruptSource::Nmi => {
                self.nmi_pending = false;
                self.nmi_blocked = true;
            }
        }
        Some(InterruptEvent {
            source,
            return_pc: pc,
            saved_flags: flags::architectural(live_flags, context),
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EventState {
    #[default]
    Ready,
    Pending(ExceptionEvent),
    Shutdown,
    Halted,
    PendingInterrupt(InterruptEvent),
}

impl InterruptEvent {
    pub fn validate(
        self,
        rip: u64,
        live_flags: u64,
        context: &ExecutionContext,
    ) -> Result<(), &'static str> {
        if self.return_pc != rip {
            return Err("pending interrupt return pc differs from rip");
        }
        if live_flags & !flags::IMPORTED_MASK != 0
            || live_flags & 2 == 0
            || self.saved_flags != flags::architectural(live_flags, context)
        {
            return Err("pending interrupt flags differ from live flags");
        }
        Ok(())
    }

    pub fn escalate(self, vector: u8, error_code: u16) -> EventState {
        assert!(matches!(vector, 10..=13), "selected entry protection fault");
        self.secondary(vector, error_code, None)
    }

    pub fn escalate_page_fault(self, error_code: u16, address: u64) -> EventState {
        self.secondary(14, error_code, Some(address))
    }

    fn secondary(self, vector: u8, error_code: u16, page_fault_address: Option<u64>) -> EventState {
        EventState::Pending(ExceptionEvent {
            numeric: None,
            debug: None,
            vector,
            instruction_pc: self.return_pc,
            return_pc: self.return_pc,
            saved_flags: self.saved_flags | flags::RF,
            error_code: Some(error_code),
            page_fault_address,
        })
    }
}

impl ExceptionEvent {
    pub fn validate(
        self,
        rip: u64,
        live_flags: u64,
        context: &ExecutionContext,
    ) -> Result<(), &'static str> {
        if let Some(source) = self.numeric {
            source.validate()?;
            if source.vector() != self.vector
                || source.instruction_pc != self.instruction_pc
                || self.instruction_pc != self.return_pc
                || self.debug.is_some()
                || self.page_fault_address.is_some()
            {
                return Err("numeric source differs from pending fault");
            }
        }
        let valid_code = match self.vector {
            0 | 1 | 6 | 7 | 16 | 19 => self.error_code.is_none(),
            8 => self.error_code == Some(0),
            10..=13 => self.error_code.is_some(),
            14 => self.error_code.is_some_and(|code| {
                code <= 31 && (code & 8 == 0 || code & 1 != 0) && code & 0x12 != 0x12
            }),
            _ => false,
        };
        if !valid_code {
            return Err("invalid exception vector or error code");
        }
        let valid_address = if self.vector == 14 {
            self.page_fault_address
                .is_some_and(crate::memory::canonical48)
        } else {
            self.page_fault_address.is_none()
        };
        if !valid_address {
            return Err("invalid page fault address source");
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
        if let Some(source) = self.debug {
            if self.vector != 1 || self.error_code.is_some() {
                return Err("debug source requires vector one without an error slot");
            }
            source.validate(self, architectural)?;
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
            numeric: None,
            debug: None,
            vector,
            instruction_pc: pc,
            return_pc: pc,
            saved_flags: flags::architectural(live_flags, context) | flags::RF,
            error_code,
            page_fault_address: None,
        }
    }

    pub fn page_fault(
        pc: u64,
        live_flags: u64,
        context: &ExecutionContext,
        error_code: u16,
        address: u64,
    ) -> Self {
        Self {
            page_fault_address: Some(address),
            ..Self::fault(14, pc, live_flags, context, Some(error_code))
        }
    }

    pub fn escalate(self, vector: u8, error_code: u16) -> EventState {
        assert!(matches!(vector, 10..=13), "selected entry protection fault");
        self.secondary(vector, error_code, None)
    }

    pub fn escalate_page_fault(self, error_code: u16, address: u64) -> EventState {
        self.secondary(14, error_code, Some(address))
    }

    fn secondary(self, vector: u8, error_code: u16, page_fault_address: Option<u64>) -> EventState {
        if self.vector == 8 {
            return EventState::Shutdown;
        }
        let double_fault = self.vector == 14 || vector != 14 && matches!(self.vector, 0 | 10..=13);
        EventState::Pending(Self {
            numeric: None,
            debug: None,
            vector: if double_fault { 8 } else { vector },
            error_code: Some(if double_fault { 0 } else { error_code }),
            page_fault_address: if double_fault {
                None
            } else {
                page_fault_address
            },
            saved_flags: self.saved_flags | flags::RF,
            ..self
        })
    }
}

impl EventState {
    pub fn halt(context: &ExecutionContext) -> Result<Self, ProtectionFault> {
        if context.mode() != Mode::Real && context.cpl() != 0 {
            return Err(ProtectionFault {
                vector: 13,
                error_code: 0,
                phase: ProtectionPhase::Privilege,
                selector: None,
            });
        }
        Ok(Self::Halted)
    }

    pub fn validate(
        self,
        rip: u64,
        live_flags: u64,
        context: &ExecutionContext,
        shadow: u32,
        interrupts: InterruptState,
    ) -> Result<(), &'static str> {
        match self {
            Self::Pending(event) => {
                event.validate(rip, live_flags, context)?;
                if let Some(source) = event.debug {
                    source.validate_shadow(shadow)?;
                }
                Ok(())
            }
            Self::PendingInterrupt(event) => {
                event.validate(rip, live_flags, context)?;
                if shadow == 2 {
                    return Err("pending interrupt retains ss inhibition");
                }
                match event.source {
                    InterruptSource::Irq(_) if live_flags & flags::IF == 0 || shadow != 0 => {
                        Err("pending irq has incompatible flags or inhibition")
                    }
                    InterruptSource::Nmi if !interrupts.nmi_blocked => {
                        Err("pending nmi requires nmi blocking")
                    }
                    _ => Ok(()),
                }
            }
            Self::Halted if shadow != 0 => Err("halted state retains inhibition"),
            Self::Halted => Ok(()),
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
    fn page_fault_checkpoint_requires_its_frozen_canonical_address_and_exact_error_class() {
        let context = ExecutionContext::default();
        let event = ExceptionEvent::page_fault(0x1000, 0x202, &context, 6, 0x501000);
        assert_eq!(event.page_fault_address, Some(0x501000));
        assert_eq!(event.saved_flags, 0x10202);
        let valid_codes = [
            0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 15, 16, 17, 20, 21, 25, 29,
        ];
        for code in 0..=63 {
            let changed = ExceptionEvent {
                error_code: Some(code),
                ..event
            };
            assert_eq!(
                changed.validate(0x1000, 0x202, &context).is_ok(),
                valid_codes.contains(&code),
                "code{code}"
            );
        }
        for address in [0, 0x501000, 0xffff_8000_0000_0000, u64::MAX] {
            assert!(
                ExceptionEvent {
                    page_fault_address: Some(address),
                    ..event
                }
                .validate(0x1000, 0x202, &context)
                .is_ok()
            );
        }
        for address in [
            None,
            Some(0x0000_8000_0000_0000),
            Some(0x000f_ffff_ffff_ffff),
        ] {
            assert!(
                ExceptionEvent {
                    page_fault_address: address,
                    ..event
                }
                .validate(0x1000, 0x202, &context)
                .is_err()
            );
        }
        assert!(
            ExceptionEvent {
                error_code: None,
                ..event
            }
            .validate(0x1000, 0x202, &context)
            .is_err()
        );
        for vector in [0, 1, 6, 8, 10, 11, 12, 13, 16, 19] {
            let changed = ExceptionEvent {
                vector,
                error_code: matches!(vector, 8 | 10..=13).then_some(0),
                ..event
            };
            assert!(
                changed.validate(0x1000, 0x202, &context).is_err(),
                "vector{vector}"
            );
        }
        let historical = ExceptionEvent {
            instruction_pc: 0xff0,
            ..event
        };
        assert!(historical.validate(0x1000, 0x202, &context).is_ok());
    }

    #[test]
    fn page_fault_escalation_is_asymmetric_and_replaces_obsolete_source_metadata() {
        let context = ExecutionContext::default();
        for original in [1, 6, 0, 10, 11, 12, 13, 14, 8] {
            let error_code = matches!(original, 8 | 10..=14).then_some(0);
            let mut event = ExceptionEvent::fault(original, 0x1000, 0x202, &context, error_code);
            event.page_fault_address = (original == 14).then_some(0x500000);
            event.return_pc = 0x1010;
            assert!(event.validate(0x1010, 0x202, &context).is_ok());
            let result = event.escalate_page_fault(2, 0x600000);
            if original == 8 {
                assert_eq!(result, EventState::Shutdown);
                continue;
            }
            let EventState::Pending(next) = result else {
                panic!("{original}")
            };
            assert_eq!(
                (next.vector, next.error_code, next.page_fault_address),
                if original == 14 {
                    (8, Some(0), None)
                } else {
                    (14, Some(2), Some(0x600000))
                }
            );
            assert_eq!(
                (
                    next.instruction_pc,
                    next.return_pc,
                    next.saved_flags,
                    next.debug
                ),
                (0x1000, 0x1010, 0x10202, None)
            );
            assert!(next.validate(0x1010, 0x202, &context).is_ok());
        }
        let pf = ExceptionEvent::page_fault(0x1000, 0x202, &context, 6, 0x501000);
        for vector in 10..=13 {
            let EventState::Pending(df) = pf.escalate(vector, 0x2b) else {
                panic!("{vector}")
            };
            assert_eq!(
                (df.vector, df.error_code, df.page_fault_address),
                (8, Some(0), None)
            );
        }
        let debug = ExceptionEvent {
            debug: Some(super::super::debug::Source::Execute(1)),
            saved_flags: 2,
            ..ExceptionEvent::fault(1, 0x1000, 2, &context, None)
        };
        assert!(debug.validate(0x1000, 2, &context).is_ok());
        let EventState::Pending(next) = debug.escalate_page_fault(0, 0x700000) else {
            panic!()
        };
        assert_eq!(
            (next.vector, next.debug, next.page_fault_address),
            (14, None, Some(0x700000))
        );
        for source in [InterruptSource::Nmi, InterruptSource::Irq(14)] {
            let event = InterruptEvent {
                source,
                return_pc: 0x2000,
                saved_flags: 0x202,
            };
            let EventState::Pending(next) = event.escalate_page_fault(0, 0x800000) else {
                panic!()
            };
            assert_eq!(
                (next.vector, next.page_fault_address, next.saved_flags),
                (14, Some(0x800000), 0x10202)
            );
            assert!(next.validate(0x2000, 0x202, &context).is_ok());
        }
    }

    #[test]
    fn exception_checkpoint_validates_boundary_flags_vm_and_error_code_together() {
        let context = ExecutionContext::default();
        let event = ExceptionEvent::fault(13, 0x1000, 0x202, &context, Some(0));
        assert_eq!(event.saved_flags, 0x10202);
        assert!(event.validate(0x1000, 0x202, &context).is_ok());
        for changed in [
            ExceptionEvent {
                debug: None,
                vector: 14,
                ..event
            },
            ExceptionEvent {
                debug: None,
                return_pc: 0x1001,
                ..event
            },
            ExceptionEvent {
                debug: None,
                saved_flags: 0x202,
                ..event
            },
            ExceptionEvent {
                debug: None,
                saved_flags: 0x10203,
                ..event
            },
            ExceptionEvent {
                debug: None,
                saved_flags: 0x30202,
                ..event
            },
            ExceptionEvent {
                debug: None,
                saved_flags: 0x10200,
                ..event
            },
            ExceptionEvent {
                debug: None,
                saved_flags: 1 << 63 | 0x10202,
                ..event
            },
            ExceptionEvent {
                debug: None,
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
                    debug: None,
                    error_code: if error_code.is_some() { None } else { Some(0) },
                    ..event
                }
                .validate(0x1000, flags::TF | 2, &context)
                .is_err()
            );
            let without_rf = ExceptionEvent {
                debug: None,
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
        assert!(
            EventState::Ready
                .validate(0x1000, 2, &context, 0, InterruptState::default())
                .is_ok()
        );
        assert!(
            EventState::Shutdown
                .validate(0x1000, 2, &context, 0, InterruptState::default())
                .is_ok()
        );
    }

    #[test]
    fn escalation_distinguishes_benign_contributory_and_double_fault_entry() {
        let context = ExecutionContext::default();
        for vector in [1, 6, 16, 19, 0, 10, 11, 12, 13, 8] {
            let event = ExceptionEvent {
                numeric: None,
                page_fault_address: None,
                debug: None,
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

    #[test]
    fn external_selection_uses_source_kind_and_captures_before_instruction_flags() {
        let context = ExecutionContext::default();
        let mut interrupts = InterruptState {
            irq: Some(2),
            nmi_pending: true,
            nmi_blocked: false,
        };
        assert!(interrupts.accept(0x1000, 0x10202, &context, 2).is_none());
        let nmi = interrupts.accept(0x1000, 0x10202, &context, 1).unwrap();
        assert_eq!(nmi.source, InterruptSource::Nmi);
        assert_eq!(nmi.saved_flags, 0x10202);
        assert_eq!(nmi.return_pc, 0x1000);
        assert_eq!(interrupts.irq, Some(2));
        assert!(interrupts.nmi_blocked);
        assert!(!interrupts.nmi_pending);
        assert!(interrupts.accept(0x1000, 2, &context, 0).is_none());
        let irq = interrupts.accept(0x1000, 0x202, &context, 0).unwrap();
        assert_eq!(irq.source, InterruptSource::Irq(2));
        assert_eq!(irq.saved_flags, 0x202);
        assert!(interrupts.nmi_blocked);
        assert_eq!(interrupts.irq, None);
    }

    #[test]
    fn external_checkpoint_requires_captured_eligibility_and_exact_rf() {
        let context = ExecutionContext::default();
        let event = InterruptEvent {
            source: InterruptSource::Irq(13),
            return_pc: 0x1000,
            saved_flags: 0x10202,
        };
        assert!(event.validate(0x1000, 0x10202, &context).is_ok());
        assert!(event.validate(0x1000, 0x202, &context).is_err());
        let state = EventState::PendingInterrupt(event);
        assert!(
            state
                .validate(0x1000, 0x10202, &context, 0, InterruptState::default())
                .is_ok()
        );
        for shadow in [1, 2] {
            assert!(
                state
                    .validate(0x1000, 0x10202, &context, shadow, InterruptState::default())
                    .is_err()
            );
        }
        let nmi = EventState::PendingInterrupt(InterruptEvent {
            source: InterruptSource::Nmi,
            return_pc: 0x1000,
            saved_flags: 2,
        });
        assert!(
            nmi.validate(0x1000, 2, &context, 0, InterruptState::default())
                .is_err()
        );
        let blocked = InterruptState {
            nmi_blocked: true,
            ..InterruptState::default()
        };
        assert!(nmi.validate(0x1000, 2, &context, 1, blocked).is_ok());
        assert!(nmi.validate(0x1000, 2, &context, 2, blocked).is_err());
        assert!(
            EventState::Halted
                .validate(0x1000, 2, &context, 1, blocked)
                .is_err()
        );
    }

    #[test]
    fn external_entry_failure_is_benign_even_for_contributory_or_df_vectors() {
        for source in [
            InterruptSource::Irq(0),
            InterruptSource::Irq(8),
            InterruptSource::Irq(13),
            InterruptSource::Nmi,
        ] {
            let event = InterruptEvent {
                source,
                return_pc: 0x1234,
                saved_flags: 0x202,
            };
            assert_eq!(
                event.escalate(11, 0x6b),
                EventState::Pending(ExceptionEvent {
                    numeric: None,
                    page_fault_address: None,
                    debug: None,
                    vector: 11,
                    instruction_pc: 0x1234,
                    return_pc: 0x1234,
                    saved_flags: 0x10202,
                    error_code: Some(0x6b),
                })
            );
        }
    }

    #[test]
    fn halt_activity_requires_privilege_zero_in_every_non_real_mode() {
        use crate::x86::protection::{ProtectionFault, ProtectionPhase};
        for mode in [
            "real",
            "protected",
            "compatibility",
            "long64",
            "virtual8086",
        ] {
            for cpl in 0..=3 {
                if (mode == "real" && cpl != 0) || (mode == "virtual8086" && cpl != 3) {
                    continue;
                }
                let mut value = ExecutionContext::default().to_json();
                value["mode"] = serde_json::json!(mode);
                value["cpl"] = serde_json::json!(cpl);
                if mode == "virtual8086" {
                    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
                        value["segments"][name]["selector"] = serde_json::json!(0);
                        value["segments"][name]["base"] = serde_json::json!("0x0");
                        value["segments"][name]["limit"] = serde_json::json!(0xffff);
                        value["segments"][name]["type"] = serde_json::json!("read-write");
                        value["segments"][name]["default32"] = serde_json::json!(false);
                    }
                }
                let context = ExecutionContext::from_json(&value).unwrap();
                assert_eq!(
                    EventState::halt(&context),
                    if mode == "real" || cpl == 0 {
                        Ok(EventState::Halted)
                    } else {
                        Err(ProtectionFault {
                            vector: 13,
                            error_code: 0,
                            phase: ProtectionPhase::Privilege,
                            selector: None,
                        })
                    },
                    "{mode} cpl{cpl}"
                );
            }
        }
    }
}

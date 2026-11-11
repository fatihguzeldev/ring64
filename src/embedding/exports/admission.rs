use super::*;
use crate::x86::instruction::Operation;

impl Core {
    // These checks precede the generated instruction-begin/RF effect. Numeric
    // enable faults win over the old pending x87 condition, including NE=0.
    pub(super) fn instruction_admission(&mut self, operation: Operation, pc: u64) -> i32 {
        if let Operation::DebugRegister { register, .. } = operation
            && self.debug_register_admission(register) != 0
        {
            return INVALID;
        }
        let reason = self.numeric_admission(operation, pc);
        if reason != 0 {
            return reason;
        }
        let waiting = match operation {
            Operation::X87(instruction) => instruction.op.is_waiting(),
            Operation::Mmx { op, .. } => op.checks_pending(),
            Operation::NumericImage { op, .. } => op.is_waiting(),
            Operation::MaskedStore { mmx, .. } => mmx,
            _ => false,
        };
        if waiting
            && unsafe { (*self.state.get()).x87.pending() } != 0
            && self.pending_x87_reason() == UNSUPPORTED
        {
            UNSUPPORTED
        } else {
            0
        }
    }
}

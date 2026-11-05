use super::{Emitter, GPR, LHS, RESULT, RHS, VALUE};
use crate::x86::instruction::{Address, Alu, MemoryAluOperands, Width};
use wasm_encoder::Instruction as Op;

impl Emitter {
    pub(super) fn memory_integer(
        &mut self,
        kind: Alu,
        address: Address,
        operands: MemoryAluOperands,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let writes_memory =
            matches!(operands, MemoryAluOperands::MemoryFirst(_)) && kind.writes_result();
        self.load_value(address, width, next_pc, writes_memory, exit_depth);
        match operands {
            MemoryAluOperands::MemoryFirst(source) => {
                self.op(Op::LocalGet(VALUE));
                self.narrow(width);
                self.op(Op::LocalSet(LHS));
                self.operand(source, width);
                self.op(Op::LocalSet(RHS));
            }
            MemoryAluOperands::RegisterFirst(register) => {
                self.register(register, width);
                self.op(Op::LocalSet(LHS)).op(Op::LocalGet(VALUE));
                self.narrow(width);
                self.op(Op::LocalSet(RHS));
            }
        }
        match kind {
            Alu::Add | Alu::Sub | Alu::Cmp => self.arithmetic_result(kind, width),
            Alu::And | Alu::Or | Alu::Xor | Alu::Test => {
                self.op(Op::LocalGet(LHS)).op(Op::LocalGet(RHS));
                self.logical_result(kind);
            }
        }
        if writes_memory {
            self.store_result(width, exit_depth);
        }
        // A failed store exits above with the incoming flags still live.
        match kind {
            Alu::Add | Alu::Sub | Alu::Cmp => self.arithmetic_flags(kind, width),
            Alu::And | Alu::Or | Alu::Xor | Alu::Test => self.logical_flags(width),
        }
        if let MemoryAluOperands::RegisterFirst(register) = operands
            && kind.writes_result()
        {
            self.op(Op::LocalGet(RESULT))
                .op(Op::LocalSet(GPR + u32::from(register)));
        }
    }
}

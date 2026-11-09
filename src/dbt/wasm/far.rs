use super::{Emitter, GPR, REASON, REMAINING, RIP};
use crate::embedding::layout::{DISPATCH, RunState};
use crate::x86::context::Segment;
use crate::x86::instruction::{FarInstruction, FarOperand};
use std::mem::offset_of;
use wasm_encoder::{Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn far_control(&mut self, far: FarInstruction, next_pc: u64, exit_depth: u32) {
        let helper = self.far_control.expect("far control import");
        self.op(Op::I32Const(far.descriptor().encode() as i32));
        let (selector, segment) = match far.operand {
            FarOperand::Immediate { selector, offset } => {
                self.op(Op::I64Const(offset as i64));
                (selector, Segment::Ds)
            }
            FarOperand::Memory(address) => {
                self.address(address, next_pc);
                (0, address.segment)
            }
            FarOperand::Return { cleanup } => {
                self.op(Op::I64Const(i64::from(cleanup)));
                (0, Segment::Ss)
            }
        };
        self.op(Op::I32Const(i32::from(selector)))
            .op(Op::LocalGet(GPR + 4))
            .op(Op::I64Const(next_pc as i64))
            .op(Op::I32Const(segment as i32))
            .op(Op::Call(helper))
            .op(Op::LocalTee(REASON))
            .op(Op::BrIf(exit_depth));
        let scratch = offset_of!(RunState, vector_scratch) as u64;
        for (offset, local) in [(scratch, RIP), (scratch + 8, GPR + 4)] {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(MemArg {
                    offset,
                    align: 0,
                    memory_index: 0,
                }))
                .op(Op::LocalSet(local));
        }
        self.op(Op::LocalGet(REMAINING))
            .op(Op::I64Const(1))
            .op(Op::I64Sub)
            .op(Op::LocalSet(REMAINING));
        self.gates(exit_depth);
        self.exit(DISPATCH, exit_depth);
    }
}

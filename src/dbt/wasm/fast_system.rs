use super::{DIRECTION, Emitter, FLAGS, GPR, REASON, REMAINING, RESULT, RIP, SYSTEM};
use crate::embedding::layout::{DISPATCH, RunState};
use crate::x86::fast_system::Instruction;
use std::mem::offset_of;
use wasm_encoder::{Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn fast_system(&mut self, instruction: Instruction, next: u64, depth: u32) {
        let (kind, wide) = match instruction {
            Instruction::Syscall => (0, false),
            Instruction::Sysret { wide } => (1, wide),
            Instruction::Sysenter => (2, false),
            Instruction::Sysexit { wide } => (3, wide),
            Instruction::Swapgs => (4, false),
        };
        self.op(Op::I32Const(kind))
            .op(Op::I32Const(i32::from(wide)))
            .op(Op::I64Const(next as i64));
        for register in [4, 1, 2, 11] {
            self.op(Op::LocalGet(GPR + register));
        }
        self.full_flags();
        self.op(Op::Call(self.fast_system.expect("fast system import")))
            .op(Op::LocalTee(REASON))
            .op(Op::BrIf(depth));
        for (offset, local) in [
            (offset_of!(RunState, rip), RIP),
            (offset_of!(RunState, registers) + 4 * 8, GPR + 4),
            (offset_of!(RunState, registers) + 8, GPR + 1),
            (offset_of!(RunState, registers) + 11 * 8, GPR + 11),
            (offset_of!(RunState, flags), RESULT),
        ] {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(MemArg {
                    offset: offset as u64,
                    align: 3,
                    memory_index: 0,
                }))
                .op(Op::LocalSet(local));
        }
        for (local, mask) in [(FLAGS, 0x8d7), (DIRECTION, 0x400), (SYSTEM, !0xcd7)] {
            self.op(Op::LocalGet(RESULT))
                .op(Op::I64Const(mask))
                .op(Op::I64And)
                .op(Op::LocalSet(local));
        }
        if self.observed
            && matches!(
                instruction,
                Instruction::Syscall | Instruction::Sysret { .. }
            )
        {
            // These two transfers sample TF after installing their new flags.
            let sampled_tf = self.sampled_tf.unwrap();
            self.op(Op::LocalGet(SYSTEM))
                .op(Op::I64Const(0x100))
                .op(Op::I64And)
                .op(Op::I64Eqz)
                .op(Op::I32Eqz)
                .op(Op::LocalSet(sampled_tf));
        }
        self.op(Op::LocalGet(REMAINING))
            .op(Op::I64Const(1))
            .op(Op::I64Sub)
            .op(Op::LocalSet(REMAINING));
        if self.finish_instruction(depth) {
            return;
        }
        self.external_boundary(depth);
        self.gates(depth);
        self.exit(DISPATCH, depth);
    }
}

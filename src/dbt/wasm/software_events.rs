use super::{DIRECTION, Emitter, FLAGS, GPR, REASON, REMAINING, RESULT, RIP, SHADOW, SYSTEM};
use crate::embedding::layout::{DISPATCH, RunState};
use crate::x86::instruction::{SoftwareEventDescriptor, SoftwareEventKind};
use std::mem::offset_of;
use wasm_encoder::{BlockType, Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn software_event(
        &mut self,
        operation: SoftwareEventDescriptor,
        next_pc: u64,
        exit_depth: u32,
    ) -> bool {
        if operation.kind == SoftwareEventKind::Into {
            self.op(Op::LocalGet(FLAGS))
                .op(Op::I64Const(0x800))
                .op(Op::I64And)
                .op(Op::I64Eqz)
                .op(Op::I32Eqz)
                .op(Op::If(BlockType::Empty));
            self.event_transfer(operation, next_pc, exit_depth + 1);
            self.op(Op::End);
            return false;
        }
        self.event_transfer(operation, next_pc, exit_depth);
        true
    }

    fn event_transfer(
        &mut self,
        operation: SoftwareEventDescriptor,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let helper = self.software_event.expect("software event import");
        self.op(Op::I32Const(operation.encode() as i32))
            .op(Op::LocalGet(GPR + 4));
        self.full_flags();
        self.op(Op::I64Const(next_pc as i64))
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
        self.op(Op::LocalGet(0))
            .op(Op::I64Load(MemArg {
                offset: offset_of!(RunState, flags) as u64,
                align: 3,
                memory_index: 0,
            }))
            .op(Op::LocalSet(RESULT));
        for (local, mask) in [(FLAGS, 0x8d7), (DIRECTION, 0x400), (SYSTEM, !0xcd7)] {
            self.op(Op::LocalGet(RESULT))
                .op(Op::I64Const(mask))
                .op(Op::I64And)
                .op(Op::LocalSet(local));
        }
        self.op(Op::I32Const(0))
            .op(Op::LocalSet(SHADOW))
            .op(Op::LocalGet(REMAINING))
            .op(Op::I64Const(1))
            .op(Op::I64Sub)
            .op(Op::LocalSet(REMAINING));
        if operation.kind == SoftwareEventKind::Return && self.finish_instruction(exit_depth) {
            return;
        }
        // Entry clears TF; only IRET can retain the incoming instruction-step decision.
        if operation.kind == SoftwareEventKind::Return {
            self.external_boundary(exit_depth);
        }
        self.gates(exit_depth);
        self.exit(DISPATCH, exit_depth);
    }
}

use super::{DIRECTION, Emitter, FLAGS, REASON, REPEAT_REMAINING, RIP, SHADOW, SYSTEM};
use crate::embedding::layout::{DISPATCH, RunState};
use crate::x86::instruction::{Operation, ProtectionKind, Repeat, SystemFlagsKind};
use std::mem::offset_of;
use wasm_encoder::{BlockType, Instruction as Op, MemArg};

pub(super) fn ss_producer(operation: Operation) -> bool {
    matches!(
        operation,
        Operation::PopSs { .. }
            | Operation::Protection(crate::x86::instruction::ProtectionInstruction {
                kind: ProtectionKind::LoadSegment(crate::x86::context::Segment::Ss),
                ..
            })
    )
}

impl Emitter {
    pub(super) fn full_flags(&mut self) {
        self.op(Op::LocalGet(FLAGS))
            .op(Op::LocalGet(DIRECTION))
            .op(Op::I64Or);
        self.system_bits();
        self.op(Op::I64Or);
    }

    pub(super) fn system_bits(&mut self) {
        if self.observed || self.mutable_controls {
            self.op(Op::LocalGet(SYSTEM));
        } else {
            // Ordinary fast units do not change controls; do not keep them live across the loop.
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(MemArg {
                    offset: offset_of!(RunState, flags) as u64,
                    align: 3,
                    memory_index: 0,
                }))
                .op(Op::I64Const(!0xcd7))
                .op(Op::I64And);
        }
    }

    pub(super) fn profile_guard(&mut self, exit_depth: u32) {
        let observed = i32::from(self.observed);
        self.op(Op::LocalGet(SYSTEM))
            .op(Op::I64Const(0x10100))
            .op(Op::I64And)
            .op(Op::I64Eqz)
            .op(Op::I32Eqz)
            .op(Op::LocalGet(SHADOW))
            .op(Op::I32Or)
            .op(Op::I32Eqz)
            .op(Op::I32Eqz)
            .op(Op::I32Const(observed))
            .op(Op::I32Ne)
            .op(Op::If(BlockType::Empty));
        self.exit(DISPATCH, exit_depth + 1);
        self.op(Op::End);
    }

    fn clear_resume(&mut self) {
        self.op(Op::LocalGet(SYSTEM))
            .op(Op::I64Const(!0x10000))
            .op(Op::I64And)
            .op(Op::LocalSet(SYSTEM));
    }

    pub(super) fn begin(&mut self, operation: Operation, exit_depth: u32) {
        if !self.observed {
            return;
        }
        let sampled_tf = self.sampled_tf.unwrap();
        let incoming_shadow = self.incoming_shadow.unwrap();
        let next_shadow = self.next_shadow.unwrap();
        self.op(Op::LocalGet(SYSTEM))
            .op(Op::I64Const(0x100))
            .op(Op::I64And)
            .op(Op::I64Eqz)
            .op(Op::I32Eqz)
            .op(Op::LocalSet(sampled_tf))
            .op(Op::LocalGet(SHADOW))
            .op(Op::LocalSet(incoming_shadow))
            .op(Op::I32Const(0))
            .op(Op::LocalSet(next_shadow));
        if let Operation::String {
            repeat,
            address_width,
            ..
        } = operation
            && repeat != Repeat::None
        {
            // A private no-work suspension is before the instruction-begin effect.
            self.register(1, address_width);
            self.op(Op::I64Eqz)
                .op(Op::LocalGet(REPEAT_REMAINING))
                .op(Op::I64Eqz)
                .op(Op::I32Eqz)
                .op(Op::I32Or)
                .op(Op::If(BlockType::Empty));
            self.clear_resume();
            self.op(Op::End);
            return;
        }
        let waiting = match operation {
            Operation::X87(instruction) => instruction.op.is_waiting(),
            Operation::Mmx { op, .. } => op.checks_pending(),
            Operation::NumericImage { op, .. } => op.is_waiting(),
            Operation::MaskedStore { mmx, .. } => mmx,
            _ => false,
        };
        if waiting {
            self.mmx_pending(exit_depth);
        }
        self.clear_resume();
    }

    fn ss_producer(&self) -> bool {
        ss_producer(self.current_operation)
    }

    pub(super) fn trap(&mut self, completed: bool, exit_depth: u32) {
        if !self.observed {
            return;
        }
        let instruction_pc = self.current_pc;
        self.op(Op::LocalGet(self.sampled_tf.unwrap()));
        if self.ss_producer() {
            self.op(Op::LocalGet(self.incoming_shadow.unwrap()))
                .op(Op::I32Const(2))
                .op(Op::I32Eq)
                .op(Op::I32And);
        }
        self.op(Op::If(BlockType::Empty))
            .op(Op::I32Const(0))
            .op(Op::LocalSet(SHADOW))
            .op(Op::I64Const(instruction_pc as i64))
            .op(Op::LocalGet(RIP))
            .op(Op::I32Const(i32::from(completed)));
        self.full_flags();
        self.op(Op::Call(self.debug_step.expect("debug boundary import")))
            .op(Op::LocalSet(REASON))
            .op(Op::Br(exit_depth + 1))
            .op(Op::End);
    }

    pub(super) fn finish_instruction(&mut self, exit_depth: u32) -> bool {
        let ss = self.ss_producer();
        if self.observed {
            if ss {
                self.op(Op::LocalGet(self.incoming_shadow.unwrap()))
                    .op(Op::I32Const(2))
                    .op(Op::I32Ne)
                    .op(Op::I32Const(1))
                    .op(Op::I32Shl)
                    .op(Op::LocalSet(SHADOW));
            } else if matches!(self.current_operation, Operation::SystemFlags(d) if d.kind == SystemFlagsKind::Sti)
            {
                self.op(Op::LocalGet(self.next_shadow.unwrap()))
                    .op(Op::LocalSet(SHADOW));
            } else {
                self.op(Op::I32Const(0)).op(Op::LocalSet(SHADOW));
            }
            self.trap(true, exit_depth);
            self.gates(exit_depth);
            self.exit(DISPATCH, exit_depth);
            return true;
        }
        if ss {
            self.op(Op::I32Const(2)).op(Op::LocalSet(SHADOW));
        }
        let terminal = ss
            || matches!(self.current_operation, Operation::SystemFlags(d)
                if matches!(d.kind, SystemFlagsKind::Pop | SystemFlagsKind::Sti));
        if terminal {
            self.gates(exit_depth);
            self.exit(DISPATCH, exit_depth);
        }
        terminal
    }
}

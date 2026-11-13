use super::{
    ADDRESS, DIRECTION, Emitter, FLAGS, GPR, LHS, REASON, RESULT, SHADOW, STORE_STATUS, SYSTEM,
    VALUE,
};
use crate::embedding::layout::RunState;
use crate::x86::context::{Mode, Segment};
use crate::x86::instruction::{
    ProtectionDescriptor, ProtectionKind, RegisterView, SystemFlagsDescriptor, SystemFlagsKind,
    Width,
};
use std::mem::offset_of;
use wasm_encoder::{BlockType, Instruction as Op, MemArg};

impl Emitter {
    fn flags_call(
        &mut self,
        operation: SystemFlagsDescriptor,
        input: Option<u32>,
        exit_depth: u32,
    ) {
        self.op(Op::I32Const(operation.encode() as i32));
        self.full_flags();
        match input {
            Some(local) => {
                self.op(Op::LocalGet(local));
            }
            None => {
                self.op(Op::I64Const(0));
            }
        }
        self.op(Op::Call(self.system_flags.expect("FLAGS import")))
            .op(Op::LocalTee(REASON))
            .op(Op::BrIf(exit_depth));
    }

    fn flags_result(&mut self) {
        self.op(Op::LocalGet(0))
            .op(Op::I64Load(MemArg {
                offset: offset_of!(RunState, vector_scratch) as u64,
                align: 0,
                memory_index: 0,
            }))
            .op(Op::LocalSet(RESULT));
    }

    fn install_flags(&mut self) {
        for (local, mask) in [(FLAGS, 0x8d7), (DIRECTION, 0x400), (SYSTEM, !0xcd7)] {
            self.op(Op::LocalGet(RESULT))
                .op(Op::I64Const(mask))
                .op(Op::I64And)
                .op(Op::LocalSet(local));
        }
    }

    fn publish_ac(&mut self) {
        let memory = MemArg {
            offset: offset_of!(RunState, flags) as u64,
            align: 3,
            memory_index: 0,
        };
        // Only successful in-unit AC producers synchronize this live permission bit.
        self.op(Op::LocalGet(0))
            .op(Op::LocalGet(0))
            .op(Op::I64Load(memory))
            .op(Op::I64Const(!crate::x86::flags::AC as i64))
            .op(Op::I64And)
            .op(Op::LocalGet(SYSTEM))
            .op(Op::I64Const(crate::x86::flags::AC as i64))
            .op(Op::I64And)
            .op(Op::I64Or)
            .op(Op::I64Store(memory));
    }

    pub(super) fn system_flags(&mut self, operation: SystemFlagsDescriptor, exit_depth: u32) {
        match operation.kind {
            SystemFlagsKind::Push => {
                self.flags_call(operation, None, exit_depth);
                self.flags_result();
                self.push_result(operation.width, exit_depth);
            }
            SystemFlagsKind::Pop => {
                if self.context.mode() == Mode::Virtual8086 {
                    self.op(Op::LocalGet(SYSTEM))
                        .op(Op::I64Const(0x3000))
                        .op(Op::I64And)
                        .op(Op::I64Const(0x3000))
                        .op(Op::I64Ne)
                        .op(Op::If(BlockType::Empty));
                    self.flags_call(operation, None, exit_depth + 1);
                    self.op(Op::End);
                }
                self.stack_word(operation.width, exit_depth);
                self.flags_call(operation, Some(VALUE), exit_depth);
                self.flags_result();
                self.install_flags();
                self.update_stack_pointer(u64::from(operation.width.bytes()));
            }
            SystemFlagsKind::Cli | SystemFlagsKind::Sti => {
                if operation.kind == SystemFlagsKind::Sti {
                    let next_shadow = self.next_shadow.unwrap_or(STORE_STATUS);
                    self.op(Op::LocalGet(SYSTEM))
                        .op(Op::I64Const(0x200))
                        .op(Op::I64And)
                        .op(Op::I64Eqz)
                        .op(Op::LocalSet(next_shadow));
                }
                self.flags_call(operation, None, exit_depth);
                self.flags_result();
                self.install_flags();
                if operation.kind == SystemFlagsKind::Sti && !self.observed {
                    self.op(Op::LocalGet(STORE_STATUS)).op(Op::LocalSet(SHADOW));
                }
            }
            SystemFlagsKind::Clac | SystemFlagsKind::Stac => {
                self.flags_call(operation, None, exit_depth);
                self.flags_result();
                self.install_flags();
                self.publish_ac();
            }
        }
    }

    pub(super) fn pop_ss(&mut self, width: Width, exit_depth: u32) {
        let protection = self.protection.expect("SS protection import");
        self.stack_word(width, exit_depth);
        let stack_width = self.context.stack_width();
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I64Const(i64::from(width.bytes())))
            .op(Op::I64Add);
        self.narrow(stack_width);
        self.merge_register(RegisterView::low(4), stack_width);
        self.op(Op::LocalSet(LHS))
            .op(Op::I32Const(
                ProtectionDescriptor {
                    kind: ProtectionKind::LoadSegment(Segment::Ss),
                    width: Width::W16,
                    memory: false,
                }
                .encode() as i32,
            ))
            .op(Op::I64Const(0))
            .op(Op::LocalGet(VALUE))
            .op(Op::I64Const(0xffff))
            .op(Op::I64And)
            .op(Op::I32Const(Segment::Ss as i32))
            .op(Op::Call(protection));
        self.numeric_state_result(exit_depth);
        self.op(Op::LocalGet(LHS))
            .op(Op::LocalSet(GPR + 4))
            .op(Op::LocalGet(REASON))
            .op(Op::LocalSet(STORE_STATUS));
        self.stores = true;
    }
}

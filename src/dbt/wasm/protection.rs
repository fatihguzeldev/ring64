use super::{Emitter, FLAGS, REASON, STORE_STATUS};
use crate::embedding::layout::RunState;
use crate::x86::context::Segment;
use crate::x86::instruction::{
    Location, ProtectionInstruction, ProtectionKind as Kind, RegisterView, Width,
};
use std::mem::offset_of;
use wasm_encoder::{BlockType, Instruction as Op, MemArg};

fn memory(offset: usize) -> MemArg {
    MemArg {
        offset: offset as u64,
        align: 0,
        memory_index: 0,
    }
}

impl Emitter {
    pub(super) fn protection(
        &mut self,
        instruction: ProtectionInstruction,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let helper = self.protection.expect("protection import");
        self.op(Op::I32Const(instruction.descriptor().encode() as i32));
        let segment = match instruction.operand {
            Location::Memory(address) => {
                self.address(address, next_pc);
                address.segment
            }
            Location::Register(_) => {
                self.op(Op::I64Const(0));
                Segment::Ds
            }
        };
        if matches!(
            instruction.kind,
            Kind::LoadLdt | Kind::LoadSegment(_) | Kind::Lar | Kind::Lsl | Kind::Verr | Kind::Verw
        ) && let Location::Register(register) = instruction.operand
        {
            self.data_register(register, Width::W16);
        } else {
            self.op(Op::I64Const(0));
        }
        self.op(Op::I32Const(segment as i32)).op(Op::Call(helper));
        self.numeric_state_result(exit_depth);
        let scratch = offset_of!(RunState, vector_scratch);
        let destination = match instruction.kind {
            Kind::ReadLdt | Kind::ReadSegment(_) => match instruction.operand {
                Location::Register(register) => Some(register),
                _ => None,
            },
            Kind::LoadFar(_) | Kind::Lar | Kind::Lsl => {
                Some(RegisterView::low(instruction.register))
            }
            _ => None,
        };
        if let Some(destination) = destination {
            self.op(Op::LocalGet(0))
                .op(Op::I32Load8U(memory(scratch + 8)))
                .op(Op::I32Const(1))
                .op(Op::I32And)
                .op(Op::If(BlockType::Empty))
                .op(Op::LocalGet(0))
                .op(Op::I64Load(memory(scratch)));
            self.write_register(destination, instruction.width);
            self.op(Op::End);
        }
        if matches!(
            instruction.kind,
            Kind::Lar | Kind::Lsl | Kind::Verr | Kind::Verw
        ) {
            self.op(Op::LocalGet(FLAGS))
                .op(Op::I64Const(!0x40))
                .op(Op::I64And)
                .op(Op::LocalGet(0))
                .op(Op::I32Load8U(memory(scratch + 8)))
                .op(Op::I32Const(2))
                .op(Op::I32And)
                .op(Op::I64ExtendI32U)
                .op(Op::I64Const(5))
                .op(Op::I64Shl)
                .op(Op::I64Or)
                .op(Op::LocalSet(FLAGS));
        }
        // Context replacement and code writes share the completed redispatch boundary.
        self.op(Op::LocalGet(REASON)).op(Op::LocalSet(STORE_STATUS));
        self.stores = true;
    }
}

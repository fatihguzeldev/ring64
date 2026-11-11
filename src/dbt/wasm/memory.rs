use super::{ADDRESS, Emitter, GPR, REASON, RESULT, STORE_STATUS, VALUE};
use crate::embedding::layout::{DATA, RunState};
use crate::x86::context::Segment;
use crate::x86::instruction::{Address, AddressBase, DataOperand, RegisterView, Width};
use wasm_encoder::{BlockType, Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn address(&mut self, address: Address, next_pc: u64) {
        self.address_with_stack(address, next_pc, None);
    }

    pub(super) fn address_with_stack(
        &mut self,
        address: Address,
        next_pc: u64,
        pending_stack: Option<u32>,
    ) {
        self.segment = address.segment;
        let has_base = if let AddressBase::Register(base) = address.base {
            self.op(Op::LocalGet(if base == 4 {
                pending_stack.unwrap_or(GPR + 4)
            } else {
                GPR + u32::from(base)
            }));
            true
        } else {
            false
        };
        if let Some(index) = address.index {
            self.op(Op::LocalGet(if index.register == 4 {
                pending_stack.unwrap_or(GPR + 4)
            } else {
                GPR + u32::from(index.register)
            }));
            if index.scale != 1 {
                self.op(Op::I64Const(i64::from(index.scale.trailing_zeros())))
                    .op(Op::I64Shl);
            }
            if has_base {
                self.op(Op::I64Add);
            }
        }
        let constant = if address.base == AddressBase::NextPc {
            next_pc.wrapping_add(address.displacement as u64)
        } else {
            address.displacement as u64
        };
        if constant != 0 || address.index.is_none() {
            self.op(Op::I64Const(constant as i64));
            if has_base || address.index.is_some() {
                self.op(Op::I64Add);
            }
        }
        self.narrow(address.size);
    }

    fn linear_address(&mut self) {
        self.op(Op::LocalGet(ADDRESS));
        if self.context.is_long64() {
            let base = self.context.segment_base(self.segment);
            if base != 0 {
                self.op(Op::I64Const(base as i64)).op(Op::I64Add);
            }
        }
    }

    pub(super) fn record_fault_segment(&mut self, segment: Segment) {
        self.op(Op::LocalGet(0))
            .op(Op::I32Const(segment as i32))
            .op(Op::I32Store(MemArg {
                offset: std::mem::offset_of!(RunState, fault_segment) as u64,
                align: 2,
                memory_index: 0,
            }));
    }

    fn memory_failure(&mut self, exit_depth: u32) {
        if self.paged {
            self.record_fault_segment(self.segment);
        }
        if self.restore_string_flags {
            self.restore_repeat_flags();
        }
        if let Some(reason) = self.access_reason {
            self.op(Op::Call(reason))
                .op(Op::LocalSet(REASON))
                .op(Op::Br(exit_depth));
        } else {
            self.record_fault_segment(self.segment);
            self.exit(DATA, exit_depth);
        }
    }

    pub(super) fn lea(&mut self, dst: RegisterView, address: Address, width: Width, next_pc: u64) {
        self.address(address, next_pc);
        self.narrow(width);
        self.write_register(dst, width);
    }

    pub(super) fn load(
        &mut self,
        dst: RegisterView,
        address: Address,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.load_value(address, width, next_pc, false, exit_depth);
        self.op(Op::LocalGet(VALUE));
        self.narrow(width);
        self.write_register(dst, width);
    }

    pub(super) fn load_value(
        &mut self,
        address: Address,
        width: Width,
        next_pc: u64,
        for_write: bool,
        exit_depth: u32,
    ) {
        self.address(address, next_pc);
        self.op(Op::LocalSet(ADDRESS));
        self.load_address_value(width, for_write, exit_depth);
    }

    pub(super) fn load_address_value(&mut self, width: Width, for_write: bool, exit_depth: u32) {
        self.linear_address();
        self.op(Op::I32Const(i32::from(width.bytes())));
        if !self.context.is_long64() {
            self.op(Op::I32Const(self.segment as i32));
        }
        self.op(Op::Call(if for_write { 3 } else { 0 }))
            .op(Op::LocalSet(VALUE))
            .op(Op::Call(2))
            .op(Op::If(BlockType::Empty));
        self.memory_failure(exit_depth + 1);
        self.op(Op::End);
    }

    pub(super) fn store_result(&mut self, width: Width, exit_depth: u32) {
        self.stores = true;
        self.linear_address();
        self.op(Op::I32Const(i32::from(width.bytes())))
            .op(Op::LocalGet(RESULT));
        if !self.context.is_long64() {
            self.op(Op::I32Const(self.segment as i32));
        }
        self.op(Op::Call(1))
            .op(Op::LocalTee(STORE_STATUS))
            .op(Op::I32Eqz)
            .op(Op::If(BlockType::Empty));
        self.memory_failure(exit_depth + 1);
        self.op(Op::End);
    }

    pub(super) fn store(
        &mut self,
        src: DataOperand,
        address: Address,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.address(address, next_pc);
        self.op(Op::LocalSet(ADDRESS));
        self.linear_address();
        self.op(Op::I32Const(i32::from(width.bytes())));
        self.data_operand(src, width);
        if !self.context.is_long64() {
            self.op(Op::I32Const(self.segment as i32));
        }
        self.stores = true;
        self.op(Op::Call(1))
            .op(Op::LocalTee(STORE_STATUS))
            .op(Op::I32Eqz)
            .op(Op::If(BlockType::Empty));
        self.memory_failure(exit_depth + 1);
        self.op(Op::End);
    }
}

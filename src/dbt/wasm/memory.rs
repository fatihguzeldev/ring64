use super::{ADDRESS, Emitter, GPR, RESULT, STORE_STATUS, VALUE};
use crate::embedding::layout::DATA;
use crate::x86::instruction::{Address, AddressBase, DataOperand, RegisterView, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    pub(super) fn address(&mut self, address: Address, next_pc: u64) {
        let has_base = if let AddressBase::Register(base) = address.base {
            self.op(Op::LocalGet(GPR + u32::from(base)));
            true
        } else {
            false
        };
        if let Some(index) = address.index {
            self.op(Op::LocalGet(GPR + u32::from(index.register)));
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
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I32Const(i32::from(width.bytes())))
            .op(Op::Call(if for_write { 3 } else { 0 }))
            .op(Op::LocalSet(VALUE))
            .op(Op::Call(2))
            .op(Op::If(BlockType::Empty));
        self.exit(DATA, exit_depth + 1);
        self.op(Op::End);
    }

    pub(super) fn store_result(&mut self, width: Width, exit_depth: u32) {
        self.stores = true;
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I32Const(i32::from(width.bytes())))
            .op(Op::LocalGet(RESULT))
            .op(Op::Call(1))
            .op(Op::LocalTee(STORE_STATUS))
            .op(Op::I32Eqz)
            .op(Op::If(BlockType::Empty));
        self.exit(DATA, exit_depth + 1);
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
        self.stores = true;
        self.address(address, next_pc);
        self.op(Op::LocalSet(ADDRESS))
            .op(Op::LocalGet(ADDRESS))
            .op(Op::I32Const(i32::from(width.bytes())));
        self.data_operand(src, width);
        self.op(Op::Call(1))
            .op(Op::LocalTee(STORE_STATUS))
            .op(Op::I32Eqz)
            .op(Op::If(BlockType::Empty));
        self.exit(DATA, exit_depth + 1);
        self.op(Op::End);
    }
}

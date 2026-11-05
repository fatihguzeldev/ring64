use super::{ADDRESS, Emitter, GPR, VALUE};
use crate::embedding::layout::DATA;
use crate::x86::instruction::{Address, AddressBase, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    fn address(&mut self, address: Address, next_pc: u64) {
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
        self.op(Op::LocalSet(ADDRESS));
    }

    pub(super) fn load(
        &mut self,
        dst: u8,
        address: Address,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.address(address, next_pc);
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I32Const(i32::from(width.bytes())))
            .op(Op::Call(0))
            .op(Op::LocalSet(VALUE))
            .op(Op::Call(2))
            .op(Op::If(BlockType::Empty));
        self.exit(DATA, exit_depth + 1);
        self.op(Op::End).op(Op::LocalGet(VALUE));
        self.narrow(width);
        self.op(Op::LocalSet(GPR + u32::from(dst)));
    }

    pub(super) fn store(
        &mut self,
        src: u8,
        address: Address,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.address(address, next_pc);
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I32Const(i32::from(width.bytes())));
        self.register(src, width);
        self.op(Op::Call(1))
            .op(Op::I32Eqz)
            .op(Op::If(BlockType::Empty));
        self.exit(DATA, exit_depth + 1);
        self.op(Op::End);
    }
}

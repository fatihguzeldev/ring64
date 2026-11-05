use super::{ADDRESS, Emitter, GPR, VALUE};
use crate::embedding::layout::DATA;
use crate::x86::instruction::{Address, AddressBase, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    fn address(&mut self, address: Address) {
        let (AddressBase::Register(base), None) = (address.base, address.index) else {
            unreachable!("only base-register addressing is admitted");
        };
        self.op(Op::LocalGet(GPR + u32::from(base)))
            .op(Op::I64Const(address.displacement))
            .op(Op::I64Add)
            .op(Op::LocalSet(ADDRESS));
    }

    pub(super) fn load(&mut self, dst: u8, address: Address, width: Width, exit_depth: u32) {
        self.address(address);
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

    pub(super) fn store(&mut self, src: u8, address: Address, width: Width, exit_depth: u32) {
        self.address(address);
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

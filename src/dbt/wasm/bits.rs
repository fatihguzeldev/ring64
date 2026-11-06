use super::{ADDRESS, Emitter, FLAGS, LHS, RESULT, RHS, VALUE};
use crate::x86::instruction::{Bit, BitIndex, Location, RegisterView, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    pub(super) fn bit(
        &mut self,
        kind: Bit,
        dst: Location,
        index: BitIndex,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        match index {
            BitIndex::Register(register) => self.data_register(register, width),
            BitIndex::Immediate(value) => {
                self.op(Op::I64Const(i64::from(value)));
            }
        }
        self.op(Op::LocalSet(RHS));
        match dst {
            Location::Register(register) => {
                self.data_register(register, width);
                self.op(Op::LocalSet(LHS));
            }
            Location::Memory(address) => {
                self.address(address, next_pc);
                if matches!(index, BitIndex::Register(_)) {
                    self.op(Op::LocalGet(RHS));
                    self.signed(width);
                    self.op(Op::I64Const(i64::from(width.bits().trailing_zeros())))
                        .op(Op::I64ShrS)
                        .op(Op::I64Const(i64::from(width.bytes().trailing_zeros())))
                        .op(Op::I64Shl)
                        .op(Op::I64Add);
                }
                self.op(Op::LocalSet(ADDRESS));
                self.load_address_value(width, kind.writes_result(), exit_depth);
                self.op(Op::LocalGet(VALUE));
                self.narrow(width);
                self.op(Op::LocalSet(LHS));
            }
        }
        self.op(Op::LocalGet(RHS))
            .op(Op::I64Const(i64::from(width.bits() - 1)))
            .op(Op::I64And)
            .op(Op::LocalSet(RHS))
            .op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS))
            .op(Op::I64ShrU)
            .op(Op::I64Const(1))
            .op(Op::I64And)
            .op(Op::LocalSet(VALUE));
        if kind.writes_result() {
            self.op(Op::LocalGet(LHS))
                .op(Op::I64Const(1))
                .op(Op::LocalGet(RHS))
                .op(Op::I64Shl);
            match kind {
                Bit::Set => {
                    self.op(Op::I64Or);
                }
                Bit::Reset => {
                    self.op(Op::I64Const(-1)).op(Op::I64Xor).op(Op::I64And);
                }
                Bit::Complement => {
                    self.op(Op::I64Xor);
                }
                Bit::Test => unreachable!(),
            }
            self.op(Op::LocalSet(RESULT));
            self.write_location(dst, width, exit_depth);
        }
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(0x42))
            .op(Op::I64And)
            .op(Op::LocalGet(VALUE))
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }

    pub(super) fn scan(
        &mut self,
        reverse: bool,
        dst: RegisterView,
        src: Location,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(src, width, next_pc, false, exit_depth);
        self.op(Op::LocalGet(LHS))
            .op(Op::I64Const(0))
            .op(Op::I64Ne)
            .op(Op::If(BlockType::Empty));
        if reverse {
            self.op(Op::I64Const(63))
                .op(Op::LocalGet(LHS))
                .op(Op::I64Clz)
                .op(Op::I64Sub);
        } else {
            self.op(Op::LocalGet(LHS)).op(Op::I64Ctz);
        }
        self.write_register(dst, width);
        self.op(Op::End)
            .op(Op::I64Const(2))
            .op(Op::LocalGet(LHS))
            .op(Op::I64Popcnt)
            .op(Op::I64Const(1))
            .op(Op::I64And)
            .op(Op::I64Eqz)
            .op(Op::I64ExtendI32U)
            .op(Op::I64Const(2))
            .op(Op::I64Shl)
            .op(Op::I64Or)
            .op(Op::LocalGet(LHS))
            .op(Op::I64Eqz)
            .op(Op::I64ExtendI32U)
            .op(Op::I64Const(6))
            .op(Op::I64Shl)
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }

    pub(super) fn bswap(&mut self, dst: RegisterView, width: Width) {
        self.data_register(dst, width);
        self.op(Op::LocalSet(LHS));
        for (mask, shift) in [(0x00ff00ff00ff00ffu64, 8), (0x0000ffff0000ffff, 16)] {
            if width == Width::W32 && shift == 16 {
                break;
            }
            let mask = mask & width.mask();
            self.op(Op::LocalGet(LHS))
                .op(Op::I64Const(mask as i64))
                .op(Op::I64And)
                .op(Op::I64Const(shift))
                .op(Op::I64Shl)
                .op(Op::LocalGet(LHS))
                .op(Op::I64Const(shift))
                .op(Op::I64ShrU)
                .op(Op::I64Const(mask as i64))
                .op(Op::I64And)
                .op(Op::I64Or)
                .op(Op::LocalSet(LHS));
        }
        self.op(Op::LocalGet(LHS));
        if width == Width::W32 {
            self.op(Op::I32WrapI64)
                .op(Op::I32Const(16))
                .op(Op::I32Rotl)
                .op(Op::I64ExtendI32U);
        } else {
            self.op(Op::I64Const(32)).op(Op::I64Rotl);
        }
        self.write_register(dst, width);
    }
}

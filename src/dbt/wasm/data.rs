use super::{ADDRESS, Emitter, RESULT, VALUE};
use crate::x86::instruction::{Condition, Location, RegisterView, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    fn source(&mut self, src: Location, width: Width, next_pc: u64, exit_depth: u32) {
        match src {
            Location::Register(register) => self.data_register(register, width),
            Location::Memory(address) => {
                self.load_value(address, width, next_pc, false, exit_depth);
                self.op(Op::LocalGet(VALUE));
                self.narrow(width);
            }
        }
    }

    pub(super) fn extend(
        &mut self,
        dst: RegisterView,
        src: Location,
        widths: (Width, Width),
        signed: bool,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let (source_width, width) = widths;
        self.source(src, source_width, next_pc, exit_depth);
        if signed && source_width != width {
            self.op(match source_width {
                Width::W8 => Op::I64Extend8S,
                Width::W16 => Op::I64Extend16S,
                Width::W32 => Op::I64Extend32S,
                Width::W64 => {
                    unreachable!("extension source must be narrower than its destination")
                }
            });
        }
        self.narrow(width);
        self.write_register(dst, width);
    }

    pub(super) fn sign_high(&mut self, width: Width) {
        self.op(Op::I64Const(0));
        self.register(0, width);
        self.op(Op::I64Const(i64::from(width.bits() - 1)))
            .op(Op::I64ShrU)
            .op(Op::I64Sub);
        self.narrow(width);
        self.write_register(RegisterView::low(2), width);
    }

    pub(super) fn setcc(
        &mut self,
        dst: Location,
        condition: Condition,
        next_pc: u64,
        exit_depth: u32,
    ) {
        match dst {
            Location::Register(register) => {
                self.condition(condition);
                self.op(Op::I64ExtendI32U);
                self.write_register(register, Width::W8);
            }
            Location::Memory(address) => {
                self.address(address, next_pc);
                self.op(Op::LocalSet(ADDRESS));
                self.condition(condition);
                self.op(Op::I64ExtendI32U).op(Op::LocalSet(RESULT));
                self.store_result(Width::W8, exit_depth);
            }
        }
    }

    pub(super) fn cmov(
        &mut self,
        dst: RegisterView,
        src: Location,
        width: Width,
        condition: Condition,
        next_pc: u64,
        exit_depth: u32,
    ) {
        // Even a false condition must complete the source read before writes.
        self.source(src, width, next_pc, exit_depth);
        self.op(Op::LocalSet(VALUE));
        self.condition(condition);
        self.op(Op::If(BlockType::Empty)).op(Op::LocalGet(VALUE));
        self.write_register(dst, width);
        if width == Width::W32 {
            self.op(Op::Else);
            self.data_register(dst, width);
            self.write_register(dst, width);
        }
        self.op(Op::End);
    }
}

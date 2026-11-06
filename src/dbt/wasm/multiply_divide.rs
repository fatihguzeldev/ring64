use super::{ADDRESS, Emitter, FLAGS, LHS, RESULT, RHS, VALUE};
use crate::embedding::layout::DIVIDE_ERROR;
use crate::x86::instruction::{Location, RegisterView, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    pub(super) fn multiply(
        &mut self,
        signed: bool,
        src: Location,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(src, width, next_pc, false, exit_depth);
        self.register(0, width);
        self.op(Op::LocalSet(RHS));
        self.product(signed, width);
        if width == Width::W8 {
            self.op(Op::LocalGet(RESULT));
            self.narrow(Width::W16);
            self.write_register(RegisterView::low(0), Width::W16);
        } else {
            self.op(Op::LocalGet(RESULT));
            self.narrow(width);
            self.write_register(RegisterView::low(0), width);
            self.op(Op::LocalGet(ADDRESS));
            self.write_register(RegisterView::low(2), width);
        }
        self.product_flags();
    }

    pub(super) fn imul(
        &mut self,
        dst: RegisterView,
        src: Location,
        immediate: Option<u64>,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(src, width, next_pc, false, exit_depth);
        if let Some(value) = immediate {
            self.op(Op::I64Const(value as i64));
        } else {
            self.data_register(dst, width);
        }
        self.op(Op::LocalSet(RHS));
        self.product(true, width);
        self.op(Op::LocalGet(RESULT));
        self.narrow(width);
        self.write_register(dst, width);
        self.product_flags();
    }

    fn product(&mut self, signed: bool, width: Width) {
        self.op(Op::LocalGet(LHS));
        if signed {
            self.signed(width);
        }
        self.op(Op::LocalGet(RHS));
        if signed {
            self.signed(width);
        }
        self.op(Op::I64Mul).op(Op::LocalSet(RESULT));
        if width == Width::W64 {
            let multiply_high = self.multiply_high.expect("wide product helper");
            self.op(Op::LocalGet(LHS))
                .op(Op::LocalGet(RHS))
                .op(Op::I32Const(i32::from(signed)))
                .op(Op::Call(multiply_high))
                .op(Op::LocalSet(ADDRESS));
            self.op(Op::LocalGet(ADDRESS));
            if signed {
                self.op(Op::LocalGet(RESULT))
                    .op(Op::I64Const(63))
                    .op(Op::I64ShrS);
            } else {
                self.op(Op::I64Const(0));
            }
        } else {
            self.op(Op::LocalGet(RESULT))
                .op(Op::I64Const(i64::from(width.bits())))
                .op(Op::I64ShrU);
            self.narrow(width);
            self.op(Op::LocalSet(ADDRESS));
            if signed {
                self.op(Op::LocalGet(RESULT));
                self.narrow(width);
                self.signed(width);
                self.op(Op::LocalGet(RESULT));
            } else {
                self.op(Op::LocalGet(ADDRESS)).op(Op::I64Const(0));
            }
        }
        self.op(Op::I64Ne)
            .op(Op::I64ExtendI32U)
            .op(Op::LocalSet(VALUE));
    }

    fn product_flags(&mut self) {
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(!0x801))
            .op(Op::I64And)
            .op(Op::LocalGet(VALUE))
            .op(Op::I64Const(0x801))
            .op(Op::I64Mul)
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }

    pub(super) fn divide(
        &mut self,
        signed: bool,
        src: Location,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(src, width, next_pc, false, exit_depth);
        if signed {
            self.op(Op::LocalGet(LHS));
            self.signed(width);
            self.op(Op::LocalSet(LHS));
        }
        if width == Width::W8 {
            self.register(0, Width::W16);
            if signed {
                self.signed(Width::W16);
            }
        } else if width == Width::W64 {
            self.register(2, width);
            self.op(Op::LocalSet(ADDRESS));
            self.register(0, width);
        } else {
            self.register(2, width);
            self.op(Op::I64Const(i64::from(width.bits())))
                .op(Op::I64Shl);
            self.register(0, width);
            self.op(Op::I64Or);
            if signed && width == Width::W16 {
                self.signed(Width::W32);
            }
        }
        self.op(Op::LocalSet(RHS));
        self.op(Op::LocalGet(LHS)).op(Op::I64Eqz);
        self.divide_error_if(exit_depth);
        if width == Width::W64 {
            let divide = self.divide.expect("wide division helper");
            let failed = self.divide_failed.expect("wide division status");
            self.op(Op::LocalGet(ADDRESS))
                .op(Op::LocalGet(RHS))
                .op(Op::LocalGet(LHS))
                .op(Op::I32Const(i32::from(signed)))
                .op(Op::Call(divide))
                .op(Op::LocalSet(RESULT))
                .op(Op::Call(failed));
            self.divide_error_if(exit_depth);
        } else {
            if signed && width == Width::W32 {
                // The 64-bit host quotient can overflow before its x86 range check.
                self.op(Op::LocalGet(RHS))
                    .op(Op::I64Const(i64::MIN))
                    .op(Op::I64Eq)
                    .op(Op::LocalGet(LHS))
                    .op(Op::I64Const(-1))
                    .op(Op::I64Eq)
                    .op(Op::I32And);
                self.divide_error_if(exit_depth);
            }
            self.op(Op::LocalGet(RHS))
                .op(Op::LocalGet(LHS))
                .op(if signed { Op::I64DivS } else { Op::I64DivU })
                .op(Op::LocalSet(RESULT))
                .op(Op::LocalGet(RESULT));
            if signed {
                let limit = 1i64 << (width.bits() - 1);
                self.op(Op::I64Const(-limit))
                    .op(Op::I64LtS)
                    .op(Op::LocalGet(RESULT))
                    .op(Op::I64Const(limit - 1))
                    .op(Op::I64GtS)
                    .op(Op::I32Or);
            } else {
                self.op(Op::I64Const(width.mask() as i64)).op(Op::I64GtU);
            }
            self.divide_error_if(exit_depth);
        }
        // A valid remainder fits one word, so the low-word identity is exact.
        self.op(Op::LocalGet(RHS))
            .op(Op::LocalGet(RESULT))
            .op(Op::LocalGet(LHS))
            .op(Op::I64Mul)
            .op(Op::I64Sub);
        self.narrow(width);
        self.op(Op::LocalSet(VALUE));
        self.op(Op::LocalGet(RESULT));
        self.narrow(width);
        if width == Width::W8 {
            self.op(Op::LocalGet(VALUE))
                .op(Op::I64Const(8))
                .op(Op::I64Shl)
                .op(Op::I64Or);
            self.write_register(RegisterView::low(0), Width::W16);
        } else {
            self.write_register(RegisterView::low(0), width);
            self.op(Op::LocalGet(VALUE));
            self.write_register(RegisterView::low(2), width);
        }
    }

    fn divide_error_if(&mut self, exit_depth: u32) {
        self.op(Op::If(BlockType::Empty));
        self.exit(DIVIDE_ERROR, exit_depth + 1);
        self.op(Op::End);
    }
}

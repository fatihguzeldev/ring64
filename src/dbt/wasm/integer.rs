use super::{Emitter, FLAGS, GPR, LHS, RESULT, RHS, VALUE};
use crate::x86::instruction::{Alu, DataOperand, Operand, RegisterView, Width};
use wasm_encoder::Instruction as Op;

impl Emitter {
    pub(super) fn narrow(&mut self, width: Width) {
        match width {
            Width::W8 | Width::W16 => {
                self.op(Op::I64Const(width.mask() as i64)).op(Op::I64And);
            }
            Width::W32 => {
                self.op(Op::I32WrapI64).op(Op::I64ExtendI32U);
            }
            Width::W64 => {}
        }
    }

    pub(super) fn register(&mut self, register: u8, width: Width) {
        self.op(Op::LocalGet(GPR + u32::from(register)));
        self.narrow(width);
    }

    pub(super) fn operand(&mut self, operand: Operand, width: Width) {
        match operand {
            Operand::Register(register) => self.register(register, width),
            Operand::Immediate(value) => {
                self.op(Op::I64Const(value as i64));
                self.narrow(width);
            }
        }
    }

    pub(super) fn data_register(&mut self, register: RegisterView, width: Width) {
        self.op(Op::LocalGet(GPR + u32::from(register.bank)));
        if register.high_byte {
            self.op(Op::I64Const(i64::from(register.shift())))
                .op(Op::I64ShrU);
        }
        self.narrow(width);
    }

    pub(super) fn data_operand(&mut self, operand: DataOperand, width: Width) {
        match operand {
            DataOperand::Register(register) => self.data_register(register, width),
            DataOperand::Immediate(value) => {
                self.op(Op::I64Const(value as i64));
                self.narrow(width);
            }
        }
    }

    pub(super) fn write_register(&mut self, register: RegisterView, width: Width) {
        if matches!(width, Width::W8 | Width::W16)
            || (width == Width::W32 && !self.context.is_long64())
        {
            let shift = register.shift();
            if shift != 0 {
                self.op(Op::I64Const(i64::from(shift))).op(Op::I64Shl);
            }
            self.op(Op::LocalGet(GPR + u32::from(register.bank)))
                .op(Op::I64Const(!(width.mask() << shift) as i64))
                .op(Op::I64And)
                .op(Op::I64Or);
        }
        self.op(Op::LocalSet(GPR + u32::from(register.bank)));
    }

    pub(super) fn integer(&mut self, kind: Alu, dst: RegisterView, src: DataOperand, width: Width) {
        match kind {
            Alu::And | Alu::Or | Alu::Xor | Alu::Test => self.logical(kind, dst, src, width),
            Alu::Add | Alu::Sub | Alu::Cmp | Alu::Adc | Alu::Sbb => {
                self.arithmetic(kind, dst, src, width)
            }
        }
    }

    fn arithmetic(&mut self, kind: Alu, dst: RegisterView, src: DataOperand, width: Width) {
        self.data_register(dst, width);
        self.op(Op::LocalSet(LHS));
        self.data_operand(src, width);
        self.op(Op::LocalSet(RHS));
        if matches!(kind, Alu::Adc | Alu::Sbb) {
            self.carry_result(kind, width);
            self.carry_flags(kind, width);
        } else {
            self.arithmetic_result(kind, width);
            self.arithmetic_flags(kind, width);
        }
        if kind != Alu::Cmp {
            self.op(Op::LocalGet(RESULT));
            self.write_register(dst, width);
        }
    }

    pub(super) fn carry_result(&mut self, kind: Alu, width: Width) {
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(1))
            .op(Op::I64And)
            .op(Op::LocalSet(VALUE))
            .op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS));
        let add = kind == Alu::Adc;
        self.op(if add { Op::I64Add } else { Op::I64Sub })
            .op(Op::LocalGet(VALUE))
            .op(if add { Op::I64Add } else { Op::I64Sub });
        self.narrow(width);
        self.op(Op::LocalSet(RESULT));
    }

    pub(super) fn carry_flags(&mut self, kind: Alu, width: Width) {
        let add = kind == Alu::Adc;
        // Original operands plus the final result also determine OF and AF
        // with carry. CF additionally covers the equality boundary.
        self.arithmetic_flags(if add { Alu::Add } else { Alu::Sub }, width);
        self.op(Op::LocalGet(if add { RESULT } else { LHS }))
            .op(Op::LocalGet(if add { LHS } else { RHS }))
            .op(Op::I64Eq)
            .op(Op::I64ExtendI32U)
            .op(Op::LocalGet(VALUE))
            .op(Op::I64And)
            .op(Op::LocalGet(FLAGS))
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }

    pub(super) fn arithmetic_result(&mut self, kind: Alu, width: Width) {
        self.op(Op::LocalGet(LHS)).op(Op::LocalGet(RHS));
        self.op(if kind == Alu::Add {
            Op::I64Add
        } else {
            Op::I64Sub
        });
        self.narrow(width);
        self.op(Op::LocalSet(RESULT));
    }

    pub(super) fn arithmetic_flags(&mut self, kind: Alu, width: Width) {
        self.op(Op::I64Const(2));
        if kind == Alu::Add {
            self.op(Op::LocalGet(RESULT)).op(Op::LocalGet(LHS));
        } else {
            self.op(Op::LocalGet(LHS)).op(Op::LocalGet(RHS));
        }
        self.op(Op::I64LtU).op(Op::I64ExtendI32U).op(Op::I64Or);
        self.op(Op::LocalGet(RESULT))
            .op(Op::I64Const(255))
            .op(Op::I64And)
            .op(Op::I64Popcnt)
            .op(Op::I64Const(1))
            .op(Op::I64And)
            .op(Op::I64Eqz)
            .op(Op::I64ExtendI32U)
            .op(Op::I64Const(2))
            .op(Op::I64Shl)
            .op(Op::I64Or);
        self.op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS))
            .op(Op::I64Xor)
            .op(Op::LocalGet(RESULT))
            .op(Op::I64Xor)
            .op(Op::I64Const(16))
            .op(Op::I64And)
            .op(Op::I64Or);
        self.op(Op::LocalGet(RESULT))
            .op(Op::I64Eqz)
            .op(Op::I64ExtendI32U)
            .op(Op::I64Const(6))
            .op(Op::I64Shl)
            .op(Op::I64Or);
        self.op(Op::LocalGet(RESULT))
            .op(Op::I64Const(i64::from(width.bits() - 1)))
            .op(Op::I64ShrU)
            .op(Op::I64Const(7))
            .op(Op::I64Shl)
            .op(Op::I64Or);
        self.op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS))
            .op(Op::I64Xor);
        if kind == Alu::Add {
            self.op(Op::I64Const(-1)).op(Op::I64Xor);
        }
        self.op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RESULT))
            .op(Op::I64Xor)
            .op(Op::I64And)
            .op(Op::I64Const(i64::from(width.bits() - 1)))
            .op(Op::I64ShrU)
            .op(Op::I64Const(11))
            .op(Op::I64Shl)
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }

    fn logical(&mut self, kind: Alu, dst: RegisterView, src: DataOperand, width: Width) {
        self.data_register(dst, width);
        self.data_operand(src, width);
        self.logical_result(kind);
        self.logical_flags(width);
        if kind != Alu::Test {
            self.op(Op::LocalGet(RESULT));
            self.write_register(dst, width);
        }
    }

    pub(super) fn logical_result(&mut self, kind: Alu) {
        self.op(match kind {
            Alu::And | Alu::Test => Op::I64And,
            Alu::Or => Op::I64Or,
            Alu::Xor => Op::I64Xor,
            _ => unreachable!(),
        })
        .op(Op::LocalSet(RESULT));
    }

    pub(super) fn logical_flags(&mut self, width: Width) {
        self.op(Op::I64Const(2))
            .op(Op::LocalGet(RESULT))
            .op(Op::I64Const(255))
            .op(Op::I64And)
            .op(Op::I64Popcnt)
            .op(Op::I64Const(1))
            .op(Op::I64And)
            .op(Op::I64Eqz)
            .op(Op::I64ExtendI32U)
            .op(Op::I64Const(2))
            .op(Op::I64Shl)
            .op(Op::I64Or)
            .op(Op::LocalGet(RESULT))
            .op(Op::I64Eqz)
            .op(Op::I64ExtendI32U)
            .op(Op::I64Const(6))
            .op(Op::I64Shl)
            .op(Op::I64Or)
            .op(Op::LocalGet(RESULT))
            .op(Op::I64Const(i64::from(width.bits() - 1)))
            .op(Op::I64ShrU)
            .op(Op::I64Const(7))
            .op(Op::I64Shl)
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }
}

use super::{Emitter, FLAGS, GPR, LHS, RESULT, RHS};
use crate::x86::instruction::{Alu, Operand, Width};
use wasm_encoder::Instruction as Op;

impl Emitter {
    pub(super) fn narrow(&mut self, width: Width) {
        if width == Width::W32 {
            self.op(Op::I32WrapI64).op(Op::I64ExtendI32U);
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

    pub(super) fn integer(&mut self, kind: Alu, dst: u8, src: Operand, width: Width) {
        if matches!(kind, Alu::And | Alu::Or | Alu::Xor | Alu::Test) {
            self.logical(kind, dst, src, width);
            return;
        }
        self.register(dst, width);
        self.op(Op::LocalSet(LHS));
        self.operand(src, width);
        self.op(Op::LocalSet(RHS))
            .op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS));
        self.op(if kind == Alu::Add {
            Op::I64Add
        } else {
            Op::I64Sub
        });
        self.narrow(width);
        self.op(Op::LocalSet(RESULT));
        // All admitted arithmetic forms define these six bits. No control
        // flags are admitted by this context; fixed bit 1 remains set.
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
        if kind != Alu::Cmp {
            self.op(Op::LocalGet(RESULT))
                .op(Op::LocalSet(GPR + u32::from(dst)));
        }
    }

    fn logical(&mut self, kind: Alu, dst: u8, src: Operand, width: Width) {
        self.register(dst, width);
        self.operand(src, width);
        self.op(match kind {
            Alu::And | Alu::Test => Op::I64And,
            Alu::Or => Op::I64Or,
            Alu::Xor => Op::I64Xor,
            _ => unreachable!(),
        })
        .op(Op::LocalSet(RESULT))
        .op(Op::I64Const(2))
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
        if kind != Alu::Test {
            self.op(Op::LocalGet(RESULT))
                .op(Op::LocalSet(GPR + u32::from(dst)));
        }
    }
}

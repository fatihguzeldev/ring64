use super::{Emitter, FLAGS, LHS, RESULT, RHS, VALUE};
use crate::x86::instruction::{Count, DoubleShift, Location, RegisterView, Shift, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    fn count(&mut self, count: Count, width: Width) {
        match count {
            Count::Immediate(value) => {
                self.op(Op::I64Const(i64::from(value)));
            }
            Count::Cl => self.register(1, Width::W8),
        }
        self.op(Op::I64Const(if width == Width::W64 { 63 } else { 31 }))
            .op(Op::I64And)
            .op(Op::LocalSet(RHS));
    }

    pub(super) fn shift(
        &mut self,
        kind: Shift,
        dst: Location,
        count: Count,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(dst, width, next_pc, true, exit_depth);
        self.count(count, width);
        self.op(Op::LocalGet(LHS)).op(Op::LocalSet(RESULT));
        self.op(Op::LocalGet(RHS))
            .op(Op::I64Const(0))
            .op(Op::I64Ne)
            .op(Op::If(BlockType::Empty));
        match kind {
            Shift::Shl | Shift::Shr | Shift::Sar => {
                self.op(Op::LocalGet(LHS));
                if kind == Shift::Sar {
                    self.signed(width);
                }
                self.op(Op::LocalGet(RHS)).op(match kind {
                    Shift::Shl => Op::I64Shl,
                    Shift::Shr => Op::I64ShrU,
                    _ => Op::I64ShrS,
                });
                self.narrow(width);
                self.op(Op::LocalSet(RESULT));
            }
            Shift::Rol | Shift::Ror => self.rotate_result(kind, width),
            Shift::Rcl | Shift::Rcr => self.carry_rotate_result(kind, width),
        }
        self.op(Op::End);
        self.write_location(dst, width, exit_depth);
        self.op(Op::LocalGet(RHS))
            .op(Op::I64Const(0))
            .op(Op::I64Ne)
            .op(Op::If(BlockType::Empty));
        if matches!(kind, Shift::Shl | Shift::Shr | Shift::Sar) {
            self.logical_flags(width);
            self.shift_carry(kind, width);
            self.op(Op::LocalGet(FLAGS))
                .op(Op::I64Or)
                .op(Op::LocalSet(FLAGS));
        } else if matches!(kind, Shift::Rcl | Shift::Rcr) {
            self.op(Op::LocalGet(VALUE))
                .op(Op::I64Const(0))
                .op(Op::I64Ne)
                .op(Op::If(BlockType::Empty));
            self.replace_rotate_carry(kind, width);
            self.op(Op::End);
        } else {
            self.replace_rotate_carry(kind, width);
        }
        self.op(Op::LocalGet(RHS))
            .op(Op::I64Const(1))
            .op(Op::I64Eq)
            .op(Op::If(BlockType::Empty));
        self.shift_overflow(kind, width);
        self.op(Op::End).op(Op::End);
    }

    fn signed(&mut self, width: Width) {
        match width {
            Width::W8 => {
                self.op(Op::I64Extend8S);
            }
            Width::W16 => {
                self.op(Op::I64Extend16S);
            }
            Width::W32 => {
                self.op(Op::I64Extend32S);
            }
            Width::W64 => {}
        }
    }

    fn rotate_result(&mut self, kind: Shift, width: Width) {
        if width == Width::W32 {
            self.op(Op::LocalGet(LHS))
                .op(Op::I32WrapI64)
                .op(Op::LocalGet(RHS))
                .op(Op::I32WrapI64)
                .op(if kind == Shift::Rol {
                    Op::I32Rotl
                } else {
                    Op::I32Rotr
                })
                .op(Op::I64ExtendI32U);
        } else if width == Width::W64 {
            self.op(Op::LocalGet(LHS))
                .op(Op::LocalGet(RHS))
                .op(if kind == Shift::Rol {
                    Op::I64Rotl
                } else {
                    Op::I64Rotr
                });
        } else {
            self.op(Op::LocalGet(RHS))
                .op(Op::I64Const(i64::from(width.bits() - 1)))
                .op(Op::I64And)
                .op(Op::LocalSet(VALUE));
            self.op(Op::LocalGet(LHS))
                .op(Op::LocalGet(VALUE))
                .op(if kind == Shift::Rol {
                    Op::I64Shl
                } else {
                    Op::I64ShrU
                })
                .op(Op::LocalGet(LHS))
                .op(Op::I64Const(i64::from(width.bits())))
                .op(Op::LocalGet(VALUE))
                .op(Op::I64Sub)
                .op(if kind == Shift::Rol {
                    Op::I64ShrU
                } else {
                    Op::I64Shl
                })
                .op(Op::I64Or);
            self.narrow(width);
        }
        self.op(Op::LocalSet(RESULT));
    }

    fn carry_rotate_result(&mut self, kind: Shift, width: Width) {
        self.op(Op::LocalGet(RHS));
        if matches!(width, Width::W8 | Width::W16) {
            self.op(Op::I64Const(i64::from(width.bits() + 1)))
                .op(Op::I64RemU);
        }
        self.op(Op::LocalSet(VALUE));
        self.op(Op::LocalGet(VALUE))
            .op(Op::I64Const(0))
            .op(Op::I64Ne)
            .op(Op::If(BlockType::Empty));
        self.op(Op::LocalGet(LHS))
            .op(Op::LocalGet(VALUE))
            .op(if kind == Shift::Rcl {
                Op::I64Shl
            } else {
                Op::I64ShrU
            });
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(1))
            .op(Op::I64And);
        if kind == Shift::Rcl {
            self.op(Op::LocalGet(VALUE))
                .op(Op::I64Const(1))
                .op(Op::I64Sub);
        } else {
            self.op(Op::I64Const(i64::from(width.bits())))
                .op(Op::LocalGet(VALUE))
                .op(Op::I64Sub);
        }
        self.op(Op::I64Shl).op(Op::I64Or);
        // Split the width+1-count shift into two shifts so count one never
        // becomes a WebAssembly shift by 64.
        self.op(Op::LocalGet(LHS))
            .op(Op::I64Const(i64::from(width.bits())))
            .op(Op::LocalGet(VALUE))
            .op(Op::I64Sub)
            .op(if kind == Shift::Rcl {
                Op::I64ShrU
            } else {
                Op::I64Shl
            })
            .op(Op::I64Const(1))
            .op(if kind == Shift::Rcl {
                Op::I64ShrU
            } else {
                Op::I64Shl
            })
            .op(Op::I64Or);
        self.narrow(width);
        self.op(Op::LocalSet(RESULT)).op(Op::End);
    }

    fn shift_carry(&mut self, kind: Shift, width: Width) {
        self.op(Op::LocalGet(LHS));
        if kind == Shift::Sar {
            self.signed(width);
        }
        if kind == Shift::Shl {
            self.op(Op::I64Const(i64::from(width.bits())))
                .op(Op::LocalGet(RHS))
                .op(Op::I64Sub);
        } else {
            self.op(Op::LocalGet(RHS))
                .op(Op::I64Const(1))
                .op(Op::I64Sub);
        }
        self.op(Op::I64ShrU).op(Op::I64Const(1)).op(Op::I64And);
    }

    fn replace_rotate_carry(&mut self, kind: Shift, width: Width) {
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(!1))
            .op(Op::I64And);
        match kind {
            Shift::Rol => {
                self.op(Op::LocalGet(RESULT));
            }
            Shift::Ror => {
                self.op(Op::LocalGet(RESULT))
                    .op(Op::I64Const(i64::from(width.bits() - 1)))
                    .op(Op::I64ShrU);
            }
            Shift::Rcl | Shift::Rcr => {
                self.op(Op::LocalGet(LHS));
                if kind == Shift::Rcl {
                    self.op(Op::I64Const(i64::from(width.bits())))
                        .op(Op::LocalGet(VALUE))
                        .op(Op::I64Sub);
                } else {
                    self.op(Op::LocalGet(VALUE))
                        .op(Op::I64Const(1))
                        .op(Op::I64Sub);
                }
                self.op(Op::I64ShrU);
            }
            _ => unreachable!(),
        }
        self.op(Op::I64Const(1))
            .op(Op::I64And)
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }

    fn shift_overflow(&mut self, kind: Shift, width: Width) {
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(!0x800))
            .op(Op::I64And);
        match kind {
            Shift::Shl | Shift::Rol | Shift::Rcl => {
                self.op(Op::LocalGet(RESULT))
                    .op(Op::I64Const(i64::from(width.bits() - 1)))
                    .op(Op::I64ShrU)
                    .op(Op::LocalGet(FLAGS))
                    .op(Op::I64Const(1))
                    .op(Op::I64And)
                    .op(Op::I64Xor);
            }
            Shift::Shr => {
                self.op(Op::LocalGet(LHS))
                    .op(Op::I64Const(i64::from(width.bits() - 1)))
                    .op(Op::I64ShrU);
            }
            Shift::Sar => {
                self.op(Op::I64Const(0));
            }
            Shift::Ror | Shift::Rcr => {
                self.op(Op::LocalGet(RESULT))
                    .op(Op::I64Const(i64::from(width.bits() - 1)))
                    .op(Op::I64ShrU)
                    .op(Op::LocalGet(RESULT))
                    .op(Op::I64Const(i64::from(width.bits() - 2)))
                    .op(Op::I64ShrU)
                    .op(Op::I64Xor);
            }
        }
        self.op(Op::I64Const(1))
            .op(Op::I64And)
            .op(Op::I64Const(11))
            .op(Op::I64Shl)
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
    }

    pub(super) fn double_shift(
        &mut self,
        kind: DoubleShift,
        dst: Location,
        inputs: (RegisterView, Count),
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let (src, count) = inputs;
        self.read_location(dst, width, next_pc, true, exit_depth);
        self.data_register(src, width);
        self.op(Op::LocalSet(VALUE));
        self.count(count, width);
        self.op(Op::LocalGet(LHS)).op(Op::LocalSet(RESULT));
        self.double_count_valid(width);
        self.op(Op::If(BlockType::Empty));
        if width == Width::W16 {
            self.op(Op::LocalGet(RHS))
                .op(Op::I64Const(16))
                .op(Op::I64Eq)
                .op(Op::If(BlockType::Result(wasm_encoder::ValType::I64)))
                .op(Op::LocalGet(VALUE))
                .op(Op::Else);
        }
        self.op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS))
            .op(if kind == DoubleShift::Left {
                Op::I64Shl
            } else {
                Op::I64ShrU
            })
            .op(Op::LocalGet(VALUE))
            .op(Op::I64Const(i64::from(width.bits())))
            .op(Op::LocalGet(RHS))
            .op(Op::I64Sub)
            .op(if kind == DoubleShift::Left {
                Op::I64ShrU
            } else {
                Op::I64Shl
            })
            .op(Op::I64Or);
        if width == Width::W16 {
            self.op(Op::End);
        }
        self.narrow(width);
        self.op(Op::LocalSet(RESULT)).op(Op::End);
        self.write_location(dst, width, exit_depth);
        self.double_count_valid(width);
        self.op(Op::If(BlockType::Empty));
        self.logical_flags(width);
        self.shift_carry(
            if kind == DoubleShift::Left {
                Shift::Shl
            } else {
                Shift::Shr
            },
            width,
        );
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
        self.op(Op::LocalGet(RHS))
            .op(Op::I64Const(1))
            .op(Op::I64Eq)
            .op(Op::If(BlockType::Empty));
        self.op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RESULT))
            .op(Op::I64Xor)
            .op(Op::I64Const(i64::from(width.bits() - 1)))
            .op(Op::I64ShrU)
            .op(Op::I64Const(11))
            .op(Op::I64Shl)
            .op(Op::LocalGet(FLAGS))
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS));
        self.op(Op::End).op(Op::End);
    }

    fn double_count_valid(&mut self, width: Width) {
        self.op(Op::LocalGet(RHS)).op(Op::I64Const(0)).op(Op::I64Ne);
        if width == Width::W16 {
            self.op(Op::LocalGet(RHS))
                .op(Op::I64Const(16))
                .op(Op::I64LeU)
                .op(Op::I32And);
        }
    }
}

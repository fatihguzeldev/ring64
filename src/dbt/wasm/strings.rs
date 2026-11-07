use super::{ADDRESS, ENTRY_FLAGS, Emitter, FLAGS, LHS, REPEAT_REMAINING, RESULT, RHS, STORE_STATUS, VALUE};
use crate::embedding::layout::{DISPATCH, REPEAT_BUDGET};
use crate::x86::context::Segment;
use crate::x86::instruction::{Address, AddressBase, Alu, RegisterView, Repeat, StringKind, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    pub(super) fn direction(&mut self, set: bool) {
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(if set { 0x400 } else { !0x400 }))
            .op(if set { Op::I64Or } else { Op::I64And })
            .op(Op::LocalSet(FLAGS));
    }

    pub(super) fn string(
        &mut self,
        kind: StringKind,
        widths: (Width, Width),
        source_segment: Segment,
        repeat: Repeat,
        exit_depth: u32,
    ) {
        if repeat == Repeat::None {
            self.string_element(kind, widths, source_segment, exit_depth);
            return;
        }
        let compare = matches!(kind, StringKind::Cmps | StringKind::Scas);
        if compare {
            self.op(Op::LocalGet(FLAGS)).op(Op::LocalSet(ENTRY_FLAGS));
        }
        // Zero-count completion preserves every raw register bank.
        self.op(Op::Block(BlockType::Empty));
        self.register(1, widths.1);
        self.op(Op::I64Eqz).op(Op::BrIf(0));
        self.op(Op::LocalGet(REPEAT_REMAINING))
            .op(Op::I64Eqz)
            .op(Op::If(BlockType::Empty));
        if compare {
            self.restore_repeat_flags();
        }
        self.exit(REPEAT_BUDGET, exit_depth + 2);
        self.op(Op::End);
        self.op(Op::Loop(BlockType::Empty));
        self.restore_string_flags = compare;
        self.string_element(kind, widths, source_segment, exit_depth + 2);
        self.restore_string_flags = false;
        self.register(1, widths.1);
        self.op(Op::I64Const(1)).op(Op::I64Sub);
        self.narrow(widths.1);
        self.write_register(RegisterView::low(1), widths.1);
        self.op(Op::LocalGet(REPEAT_REMAINING))
            .op(Op::I64Const(1))
            .op(Op::I64Sub)
            .op(Op::LocalSet(REPEAT_REMAINING));
        self.register(1, widths.1);
        self.op(Op::I64Eqz).op(Op::BrIf(1));
        if compare {
            self.op(Op::LocalGet(FLAGS))
                .op(Op::I64Const(0x40))
                .op(Op::I64And)
                .op(Op::I64Eqz);
            if repeat == Repeat::WhileNotEqual {
                self.op(Op::I32Eqz);
            }
            self.op(Op::BrIf(1));
        }
        self.op(Op::LocalGet(REPEAT_REMAINING))
            .op(Op::I64Eqz)
            .op(Op::If(BlockType::Empty));
        if compare {
            self.restore_repeat_flags();
        }
        self.exit(REPEAT_BUDGET, exit_depth + 3);
        self.op(Op::End);
        if self.stores {
            // An unfinished code-writing repeat must refetch its current form.
            self.op(Op::LocalGet(STORE_STATUS))
                .op(Op::I32Const(2))
                .op(Op::I32Eq)
                .op(Op::If(BlockType::Empty));
            self.exit(DISPATCH, exit_depth + 3);
            self.op(Op::End);
        }
        self.op(Op::Br(0)).op(Op::End).op(Op::End);
    }

    pub(super) fn restore_repeat_flags(&mut self) {
        self.op(Op::LocalGet(ENTRY_FLAGS)).op(Op::LocalSet(FLAGS));
    }

    fn string_element(
        &mut self,
        kind: StringKind,
        (width, address_width): (Width, Width),
        source_segment: Segment,
        exit_depth: u32,
    ) {
        use StringKind::*;
        if matches!(kind, Movs | Lods | Cmps) {
            self.string_address(6, address_width, source_segment);
            self.load_address_value(width, false, exit_depth);
            self.op(Op::LocalGet(VALUE));
            self.narrow(width);
            self.op(Op::LocalSet(if kind == Cmps { LHS } else { RESULT }));
        } else {
            self.register(0, width);
            self.op(Op::LocalSet(if kind == Scas { LHS } else { RESULT }));
        }
        if matches!(kind, Movs | Stos | Cmps | Scas) {
            self.string_address(7, address_width, Segment::Es);
            if matches!(kind, Movs | Stos) {
                self.store_result(width, exit_depth);
            } else {
                self.load_address_value(width, false, exit_depth);
                self.op(Op::LocalGet(VALUE));
                self.narrow(width);
                self.op(Op::LocalSet(RHS));
                self.arithmetic_result(Alu::Cmp, width);
                self.arithmetic_flags(Alu::Cmp, width);
            }
        } else {
            self.op(Op::LocalGet(RESULT));
            self.write_register(RegisterView::low(0), width);
        }
        if matches!(kind, Movs | Lods | Cmps) {
            self.string_index(6, width, address_width);
        }
        if matches!(kind, Movs | Stos | Cmps | Scas) {
            self.string_index(7, width, address_width);
        }
    }

    fn string_address(&mut self, register: u8, size: Width, segment: Segment) {
        self.address(Address {
            base: AddressBase::Register(register),
            size,
            segment,
            ..Address::default()
        }, 0);
        self.op(Op::LocalSet(ADDRESS));
    }

    fn string_index(&mut self, register: u8, width: Width, address_width: Width) {
        self.register(register, address_width);
        self.op(Op::I64Const(-(i64::from(width.bytes()))))
            .op(Op::I64Const(i64::from(width.bytes())))
            .op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(0x400))
            .op(Op::I64And)
            .op(Op::I64Eqz)
            .op(Op::I32Eqz)
            .op(Op::Select)
            .op(Op::I64Add);
        self.narrow(address_width);
        self.write_register(RegisterView::low(register), address_width);
    }
}

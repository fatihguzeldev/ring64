use super::{ADDRESS, Emitter, RESULT, RHS, VALUE};
use crate::embedding::layout::{RunState, X87_EXCEPTION};
use crate::x86::instruction::{Address, RegisterView, VectorBinary, VectorShift, Width};
use crate::x86::mmx::{Kind, Op as MmxOp};
use crate::x86::x87::State as X87State;
use std::mem::offset_of;
use wasm_encoder::{BlockType, Instruction as Op, MemArg, ValType};

const X87: usize = offset_of!(RunState, x87);
const CONTROL: usize = X87 + offset_of!(X87State, control_word);
const STATUS: usize = X87 + offset_of!(X87State, status_word);
const TAGS: usize = X87 + offset_of!(X87State, tag_word);

pub(super) fn direct(operation: MmxOp) -> bool {
    !matches!(
        operation.kind,
        Kind::PiToPs
            | Kind::PiToPd
            | Kind::PsToPi
            | Kind::PdToPi
            | Kind::TruncPsToPi
            | Kind::TruncPdToPi
    )
}

pub(super) fn vector_temps(operation: MmxOp) -> bool {
    matches!(operation.kind, Kind::Binary(_) | Kind::Shift(_))
}

fn raw(bank: u8) -> usize {
    X87 + offset_of!(X87State, registers) + usize::from(bank) * 10
}

fn memory(offset: usize) -> MemArg {
    super::vector::memory(offset)
}

impl Emitter {
    fn mmx_pending(&mut self, exit_depth: u32) {
        self.op(Op::LocalGet(0))
            .op(Op::I32Load16U(memory(STATUS)))
            .op(Op::LocalGet(0))
            .op(Op::I32Load16U(memory(CONTROL)))
            .op(Op::I32Const(-1))
            .op(Op::I32Xor)
            .op(Op::I32And)
            .op(Op::I32Const(63))
            .op(Op::I32And)
            .op(Op::If(BlockType::Empty));
        self.exit(X87_EXCEPTION, exit_depth + 1);
        self.op(Op::End);
    }

    fn mmx_transition(&mut self, empty: bool) {
        self.op(Op::LocalGet(0))
            .op(Op::LocalGet(0))
            .op(Op::I32Load16U(memory(STATUS)))
            .op(Op::I32Const(!0x3800))
            .op(Op::I32And)
            .op(Op::I32Store16(memory(STATUS)))
            .op(Op::LocalGet(0))
            .op(Op::I32Const(if empty { 0xffff } else { 0 }))
            .op(Op::I32Store16(memory(TAGS)));
    }

    fn mmx_read(&mut self, bank: u8) {
        self.op(Op::LocalGet(0)).op(Op::I64Load(memory(raw(bank))));
    }

    pub(super) fn mmx_read_vector(&mut self, bank: u8) {
        self.op(Op::LocalGet(0))
            .op(Op::V128Load64Zero(memory(raw(bank))));
    }

    fn mmx_source(&mut self, operation: MmxOp) {
        if operation.memory {
            self.op(Op::LocalGet(VALUE));
        } else {
            self.mmx_read(operation.src);
        }
    }

    fn mmx_source_vector(&mut self, operation: MmxOp) {
        if operation.memory {
            self.op(Op::V128Const(0))
                .op(Op::LocalGet(VALUE))
                .op(Op::I64x2ReplaceLane(0));
        } else {
            self.mmx_read_vector(operation.src);
        }
    }

    pub(super) fn mmx_direct(
        &mut self,
        operation: MmxOp,
        address: Option<Address>,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.mmx_pending(exit_depth);
        if operation.kind == Kind::Empty {
            self.mmx_transition(true);
            return;
        }
        if operation.is_store() {
            self.mmx_read(operation.src);
            self.op(Op::LocalSet(RESULT));
            self.address(address.expect("MMX store address"), next_pc);
            self.op(Op::LocalSet(ADDRESS));
            self.store_result(
                if operation.wide {
                    Width::W64
                } else {
                    Width::W32
                },
                exit_depth,
            );
            self.mmx_transition(false);
            return;
        }
        if let Some(address) = address {
            let width = match operation.memory_bytes() {
                2 => Width::W16,
                4 => Width::W32,
                8 => Width::W64,
                _ => unreachable!("direct MMX memory is at most eight bytes"),
            };
            self.load_value(address, width, next_pc, false, exit_depth);
        }
        match operation.kind {
            Kind::Move => {
                self.mmx_source(operation);
                self.op(Op::LocalSet(RESULT));
            }
            Kind::FromGpr => {
                if operation.memory {
                    self.op(Op::LocalGet(VALUE));
                } else {
                    self.register(
                        operation.src,
                        if operation.wide {
                            Width::W64
                        } else {
                            Width::W32
                        },
                    );
                }
                self.op(Op::LocalSet(RESULT));
            }
            Kind::ToGpr => {
                self.mmx_read(operation.src);
                let width = if operation.wide {
                    Width::W64
                } else {
                    Width::W32
                };
                self.narrow(width);
                self.write_register(RegisterView::low(operation.dst), width);
                self.mmx_transition(false);
                return;
            }
            Kind::FromXmm => {
                self.op(Op::LocalGet(self.xmm(operation.src)))
                    .op(Op::I64x2ExtractLane(0))
                    .op(Op::LocalSet(RESULT));
            }
            Kind::ToXmm => {
                let destination = self.xmm(operation.dst);
                self.op(Op::V128Const(0));
                self.mmx_read(operation.src);
                self.op(Op::I64x2ReplaceLane(0))
                    .op(Op::LocalSet(destination));
                self.mmx_transition(false);
                return;
            }
            Kind::Binary(kind) => self.mmx_binary(operation, kind),
            Kind::Shift(kind) => self.mmx_shift(operation, kind),
            Kind::Shuffle => {
                self.mmx_source_vector(operation);
                self.op(Op::V128Const(0))
                    .op(Op::I8x16Shuffle(std::array::from_fn(|i| {
                        if i < 8 {
                            ((operation.immediate >> (2 * (i / 2))) & 3) * 2 + (i % 2) as u8
                        } else {
                            16
                        }
                    })))
                    .op(Op::I64x2ExtractLane(0))
                    .op(Op::LocalSet(RESULT));
            }
            Kind::InsertWord => {
                if !operation.memory {
                    self.register(operation.src, Width::W16);
                    self.op(Op::LocalSet(VALUE));
                }
                let shift = i64::from(operation.immediate & 3) * 16;
                self.mmx_read(operation.dst);
                self.op(Op::I64Const(!(0xffffu64 << shift) as i64))
                    .op(Op::I64And)
                    .op(Op::LocalGet(VALUE))
                    .op(Op::I64Const(shift))
                    .op(Op::I64Shl)
                    .op(Op::I64Or)
                    .op(Op::LocalSet(RESULT));
            }
            Kind::ExtractWord => {
                self.mmx_read(operation.src);
                self.op(Op::I64Const(i64::from(operation.immediate & 3) * 16))
                    .op(Op::I64ShrU)
                    .op(Op::I64Const(0xffff))
                    .op(Op::I64And);
                self.write_register(RegisterView::low(operation.dst), Width::W32);
                self.mmx_transition(false);
                return;
            }
            Kind::Mask => {
                self.mmx_read_vector(operation.src);
                self.op(Op::I8x16Bitmask).op(Op::I64ExtendI32U);
                self.write_register(RegisterView::low(operation.dst), Width::W32);
                self.mmx_transition(false);
                return;
            }
            _ => unreachable!("numeric MMX conversions use the exact helper"),
        }
        self.op(Op::LocalGet(0))
            .op(Op::LocalGet(RESULT))
            .op(Op::I64Store(memory(raw(operation.dst))))
            .op(Op::LocalGet(0))
            .op(Op::I32Const(0xffff))
            .op(Op::I32Store16(memory(raw(operation.dst) + 8)));
        self.mmx_transition(false);
    }

    fn mmx_binary(&mut self, operation: MmxOp, mut kind: VectorBinary) {
        let [left, right, result] = self.vector_temps();
        self.mmx_read_vector(operation.dst);
        if matches!(kind, VectorBinary::UnpackHigh(_)) {
            self.op(Op::I32Const(32)).op(Op::I64x2ShrU);
        }
        self.op(Op::LocalSet(left));
        self.mmx_source_vector(operation);
        if let VectorBinary::UnpackHigh(width) = kind {
            self.op(Op::I32Const(32)).op(Op::I64x2ShrU);
            kind = VectorBinary::UnpackLow(width);
        }
        self.op(Op::LocalSet(right));
        self.vector_binary(kind, left, right, result);
        if matches!(
            kind,
            VectorBinary::PackSigned(_) | VectorBinary::PackUnsignedWord
        ) {
            // The 64-bit pack concatenates two four-byte halves, not two v128 halves.
            self.op(Op::LocalSet(result))
                .op(Op::LocalGet(result))
                .op(Op::LocalGet(result))
                .op(Op::I8x16Shuffle([
                    0, 1, 2, 3, 8, 9, 10, 11, 0, 1, 2, 3, 8, 9, 10, 11,
                ]));
        }
        self.op(Op::I64x2ExtractLane(0)).op(Op::LocalSet(RESULT));
    }

    fn mmx_shift(&mut self, operation: MmxOp, kind: VectorShift) {
        let [left, _, _] = self.vector_temps();
        let width = match kind {
            VectorShift::Left(width)
            | VectorShift::Right(width)
            | VectorShift::ArithmeticRight(width) => width,
            _ => unreachable!("no byte-vector shifts in MMX"),
        };
        self.mmx_read_vector(operation.dst);
        self.op(Op::LocalSet(left));
        if operation.immediate_count {
            if u32::from(operation.immediate) >= width.bits() {
                self.vector_overshift(kind, width, left);
            } else {
                self.op(Op::LocalGet(left))
                    .op(Op::I32Const(i32::from(operation.immediate)));
                self.vector_shift_op(kind);
            }
        } else {
            self.mmx_source(operation);
            self.op(Op::LocalSet(RHS))
                .op(Op::LocalGet(RHS))
                .op(Op::I64Const(i64::from(width.bits())))
                .op(Op::I64GeU)
                .op(Op::If(BlockType::Result(ValType::V128)));
            self.vector_overshift(kind, width, left);
            self.op(Op::Else)
                .op(Op::LocalGet(left))
                .op(Op::LocalGet(RHS))
                .op(Op::I32WrapI64);
            self.vector_shift_op(kind);
            self.op(Op::End);
        }
        self.op(Op::I64x2ExtractLane(0)).op(Op::LocalSet(RESULT));
    }
}

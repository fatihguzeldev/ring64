use super::{ADDRESS, Emitter, REASON, STORE_STATUS};
use crate::embedding::layout::RunState;
use crate::x86::context::Segment;
use crate::x86::instruction::{RegisterView, Width};
use wasm_encoder::{Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn io(&mut self, input: bool, port: Option<u8>, width: Width, depth: u32) {
        self.io_effect(u32::from(!input), port, width, None, depth);
        if input {
            self.op(Op::LocalGet(0)).op(Op::I64Load(MemArg {
                offset: std::mem::offset_of!(RunState, vector_scratch) as u64,
                align: 0,
                memory_index: 0,
            }));
            self.narrow(width);
            self.write_register(RegisterView::low(0), width);
        }
    }

    pub(super) fn io_effect(
        &mut self,
        kind: u32,
        port: Option<u8>,
        width: Width,
        segment: Option<Segment>,
        depth: u32,
    ) {
        self.op(Op::I32Const(
            (kind | (u32::from(width.bytes()) << 2)) as i32,
        ));
        if let Some(port) = port {
            self.op(Op::I32Const(i32::from(port)));
        } else {
            self.register(2, Width::W16);
            self.op(Op::I32WrapI64);
        }
        if segment.is_some() {
            self.op(Op::LocalGet(ADDRESS));
        } else {
            self.op(Op::I64Const(0));
        }
        if kind == 1 {
            self.register(0, width);
        } else {
            self.op(Op::I64Const(0));
        }
        self.op(Op::I32Const(segment.unwrap_or(Segment::Ds) as i32));
        self.full_flags();
        self.op(Op::Call(self.io.expect("I/O import")))
            .op(Op::LocalTee(REASON))
            .op(Op::I32Eqz)
            .op(Op::LocalGet(REASON))
            .op(Op::I32Const(2))
            .op(Op::I32Eq)
            .op(Op::I32Or)
            .op(Op::I32Eqz)
            .op(Op::BrIf(depth));
        self.op(Op::LocalGet(REASON)).op(Op::LocalSet(STORE_STATUS));
        // Permission/operand A-D effects can invalidate code even without a payload store.
        self.stores = true;
    }
}

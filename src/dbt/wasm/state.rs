use super::{DIRECTION, Emitter, FLAGS, GPR, REMAINING, REPEAT_REMAINING, RIP, SHADOW, SYSTEM};
use crate::embedding::layout::RunState;
use crate::x86::processor::TimeState;
use std::mem::{offset_of, size_of};
use wasm_encoder::{Instruction as Op, MemArg};

fn memory(offset: usize) -> MemArg {
    MemArg {
        offset: offset as u64,
        align: 3,
        memory_index: 0,
    }
}

impl Emitter {
    pub(super) fn retired(&mut self) {
        self.op(Op::LocalGet(1))
            .op(Op::LocalGet(REMAINING))
            .op(Op::I64Sub);
    }

    pub(super) fn load_state(&mut self) {
        for register in 0..16 {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(memory(
                    offset_of!(RunState, registers) + register * size_of::<u64>(),
                )))
                .op(Op::LocalSet(GPR + register as u32));
        }
        for (local, offset) in [
            (FLAGS, offset_of!(RunState, flags)),
            (RIP, offset_of!(RunState, rip)),
        ] {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(memory(offset)))
                .op(Op::LocalSet(local));
        }
        // Keep direction independent from arithmetic status producers.
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(!0xcd7))
            .op(Op::I64And)
            .op(Op::LocalSet(SYSTEM))
            .op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(0x400))
            .op(Op::I64And)
            .op(Op::LocalSet(DIRECTION))
            .op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(0x8d7))
            .op(Op::I64And)
            .op(Op::LocalSet(FLAGS));
        self.op(Op::LocalGet(0))
            .op(Op::I32Load(MemArg {
                offset: offset_of!(RunState, interruptibility) as u64,
                align: 2,
                memory_index: 0,
            }))
            .op(Op::LocalSet(SHADOW));
        self.op(Op::LocalGet(1)).op(Op::LocalSet(REMAINING));
        if self.has_repeat {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(memory(offset_of!(RunState, repeat_remaining))))
                .op(Op::LocalSet(REPEAT_REMAINING));
        }
        for bank in 0..16 {
            if let Some(local) = self.vector_registers[bank] {
                self.op(Op::LocalGet(0))
                    .op(Op::V128Load(super::vector::memory(
                        offset_of!(RunState, xmm) + bank * 16,
                    )))
                    .op(Op::LocalSet(local));
            }
        }
    }

    pub(super) fn publish_state(&mut self) {
        let tsc = offset_of!(RunState, time) + offset_of!(TimeState, tsc);
        // Helpers can rebase this same bank for WRMSR; settle each native entry once.
        self.op(Op::LocalGet(0))
            .op(Op::LocalGet(0))
            .op(Op::I64Load(memory(tsc)));
        self.retired();
        self.op(Op::I64Add).op(Op::I64Store(memory(tsc)));
        for register in 0..16 {
            self.op(Op::LocalGet(0))
                .op(Op::LocalGet(GPR + register as u32))
                .op(Op::I64Store(memory(
                    offset_of!(RunState, registers) + register * size_of::<u64>(),
                )));
        }
        for (local, offset) in [
            (FLAGS, offset_of!(RunState, flags)),
            (RIP, offset_of!(RunState, rip)),
            (REMAINING, offset_of!(RunState, remaining)),
        ] {
            self.op(Op::LocalGet(0)).op(Op::LocalGet(local));
            if local == FLAGS {
                self.op(Op::LocalGet(DIRECTION)).op(Op::I64Or);
                self.system_bits();
                self.op(Op::I64Or);
            }
            self.op(Op::I64Store(memory(offset)));
        }
        if self.publish_shadow {
            self.op(Op::LocalGet(0))
                .op(Op::LocalGet(SHADOW))
                .op(Op::I32Store(MemArg {
                    offset: offset_of!(RunState, interruptibility) as u64,
                    align: 2,
                    memory_index: 0,
                }));
        }
        if self.has_repeat {
            self.op(Op::LocalGet(0))
                .op(Op::LocalGet(REPEAT_REMAINING))
                .op(Op::I64Store(memory(offset_of!(RunState, repeat_remaining))));
        }
        for bank in 0..16 {
            if self.vector_written & (1 << bank) != 0 {
                let local = self.vector_registers[bank].expect("published XMM bank");
                self.op(Op::LocalGet(0))
                    .op(Op::LocalGet(local))
                    .op(Op::V128Store(super::vector::memory(
                        offset_of!(RunState, xmm) + bank * 16,
                    )));
            }
        }
    }
}

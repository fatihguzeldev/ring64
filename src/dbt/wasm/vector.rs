use super::{ADDRESS, Emitter, REASON, RHS, STORE_STATUS};
use crate::dbt::unit::Unit;
use crate::embedding::layout::RunState;
use crate::x86::instruction::{
    Address, Location, Operation, RegisterView, VectorBinary, VectorCount, VectorInstruction,
    VectorMask, VectorOperand, VectorShift, VectorShuffle, Width,
};
use std::mem::offset_of;
use wasm_encoder::{BlockType, Instruction as Op, MemArg, ValType};

pub(super) struct Banks {
    pub used: u16,
    pub written: u16,
    pub loads: bool,
    pub stores: bool,
}

impl Banks {
    pub fn for_unit(unit: &Unit) -> Self {
        let mut banks = Self {
            used: 0,
            written: 0,
            loads: false,
            stores: false,
        };
        for instruction in &unit.instructions {
            if let Operation::Float(float) = instruction.operation {
                if float.writes_flags() {
                    banks.read(float.dst);
                } else if !float.destination_is_gpr() {
                    banks.write(float.dst);
                }
                match float.src {
                    Location::Register(src) if !float.source_is_gpr() => banks.read(src.bank),
                    Location::Memory(_) => banks.loads = true,
                    _ => {}
                }
                continue;
            }
            let Operation::Vector(vector) = instruction.operation else {
                continue;
            };
            use VectorInstruction::*;
            match vector {
                Move {
                    register,
                    operand,
                    store,
                    ..
                }
                | HalfMove {
                    register,
                    operand,
                    store,
                    ..
                } => {
                    if store {
                        banks.read(register);
                        match operand {
                            VectorOperand::Register(dst) => banks.write(dst),
                            VectorOperand::Memory(_) => banks.stores = true,
                        }
                    } else {
                        banks.write(register);
                        banks.source(operand);
                    }
                }
                ToXmm { dst, src, .. } | InsertWord { dst, src, .. } => {
                    banks.write(dst);
                    banks.loads |= matches!(src, Location::Memory(_));
                }
                FromXmm { dst, src, .. } => {
                    banks.read(src);
                    banks.stores |= matches!(dst, Location::Memory(_));
                }
                Binary { dst, src, .. } | Shuffle { dst, src, .. } => {
                    banks.write(dst);
                    banks.source(src);
                }
                Shift { dst, count, .. } => {
                    banks.write(dst);
                    if let VectorCount::Vector(source) = count {
                        banks.source(source);
                    }
                }
                ExtractWord { src, .. } | Mask { src, .. } => banks.read(src),
            }
        }
        banks
    }

    fn read(&mut self, bank: u8) {
        self.used |= 1 << bank;
    }
    fn write(&mut self, bank: u8) {
        self.read(bank);
        self.written |= 1 << bank;
    }
    fn source(&mut self, operand: VectorOperand) {
        match operand {
            VectorOperand::Register(bank) => self.read(bank),
            VectorOperand::Memory(_) => self.loads = true,
        }
    }
}

pub(super) fn memory(offset: usize) -> MemArg {
    MemArg {
        offset: offset as u64,
        align: 0,
        memory_index: 0,
    }
}

impl Emitter {
    pub(super) fn xmm(&self, bank: u8) -> u32 {
        self.vector_registers[usize::from(bank)].expect("selected XMM bank")
    }
    pub(super) fn vector_temps(&self) -> [u32; 3] {
        self.vector_temporaries
            .expect("vector instruction has temporaries")
    }

    pub(super) fn vector_failure(&mut self, exit_depth: u32) {
        self.op(Op::Call(
            self.vector_access_reason.expect("vector access reason"),
        ))
        .op(Op::LocalSet(REASON))
        .op(Op::Br(exit_depth));
    }

    pub(super) fn vector_load_value(
        &mut self,
        address: Address,
        bytes: u8,
        aligned: bool,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let helper = self.vector_load.expect("vector load import");
        self.address(address, next_pc);
        self.op(Op::I32Const(i32::from(bytes)))
            .op(Op::I32Const(address.segment as i32))
            .op(Op::I32Const(if aligned { 16 } else { 1 }))
            .op(Op::Call(helper))
            .op(Op::LocalTee(STORE_STATUS))
            .op(Op::I32Eqz)
            .op(Op::If(BlockType::Empty));
        self.vector_failure(exit_depth + 1);
        self.op(Op::End)
            .op(Op::LocalGet(STORE_STATUS))
            .op(Op::V128Load(memory(0)));
    }

    pub(super) fn vector_operand(
        &mut self,
        operand: VectorOperand,
        bytes: u8,
        aligned: bool,
        next_pc: u64,
        exit_depth: u32,
    ) {
        match operand {
            VectorOperand::Register(bank) => {
                self.op(Op::LocalGet(self.xmm(bank)));
            }
            VectorOperand::Memory(address) => {
                self.vector_load_value(address, bytes, aligned, next_pc, exit_depth)
            }
        }
    }

    fn vector_store_value(
        &mut self,
        address: Address,
        bytes: u8,
        aligned: bool,
        value: u32,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let helper = self.vector_store.expect("vector store import");
        self.op(Op::LocalGet(0))
            .op(Op::LocalGet(value))
            .op(Op::V128Store(memory(offset_of!(RunState, vector_scratch))));
        self.address(address, next_pc);
        self.op(Op::LocalSet(ADDRESS));
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I32Const(i32::from(bytes)))
            .op(Op::I32Const(address.segment as i32))
            .op(Op::I32Const(if aligned { 16 } else { 1 }))
            .op(Op::LocalGet(0))
            .op(Op::I32Const(offset_of!(RunState, vector_scratch) as i32))
            .op(Op::I32Add)
            .op(Op::Call(helper))
            .op(Op::LocalTee(STORE_STATUS))
            .op(Op::I32Eqz)
            .op(Op::If(BlockType::Empty));
        self.vector_failure(exit_depth + 1);
        self.op(Op::End);
        self.stores = true;
    }

    pub(super) fn vector(&mut self, instruction: VectorInstruction, next_pc: u64, exit_depth: u32) {
        let [left, right, result] = self.vector_temps();
        use VectorInstruction::*;
        match instruction {
            HalfMove {
                register,
                operand,
                high,
                store,
            } => {
                if store {
                    self.op(Op::LocalGet(self.xmm(register)));
                    if high {
                        self.op(Op::LocalGet(self.xmm(register)))
                            .op(Op::I8x16Shuffle(std::array::from_fn(|i| {
                                if i < 8 { (i + 8) as u8 } else { i as u8 }
                            })));
                    }
                    self.op(Op::LocalSet(right));
                    let VectorOperand::Memory(address) = operand else {
                        unreachable!("half stores are memory-only")
                    };
                    self.vector_store_value(address, 8, false, right, next_pc, exit_depth);
                } else {
                    self.vector_operand(operand, 8, false, next_pc, exit_depth);
                    let destination = self.xmm(register);
                    self.op(Op::LocalSet(right))
                        .op(Op::LocalGet(destination))
                        .op(Op::LocalGet(right))
                        .op(Op::I8x16Shuffle(std::array::from_fn(|i| {
                            if high && i >= 8 {
                                16 + (i - 8) as u8
                            } else if !high && i < 8 {
                                16 + i as u8
                                    + if matches!(operand, VectorOperand::Register(_)) {
                                        8
                                    } else {
                                        0
                                    }
                            } else {
                                i as u8
                            }
                        })))
                        .op(Op::LocalSet(destination));
                }
            }
            Move {
                register,
                operand,
                bytes,
                preserve_upper,
                aligned,
                store,
            } => {
                let (dst, src) = if store {
                    (operand, VectorOperand::Register(register))
                } else {
                    (VectorOperand::Register(register), operand)
                };
                self.vector_operand(src, bytes, aligned, next_pc, exit_depth);
                self.op(Op::LocalSet(right));
                match dst {
                    VectorOperand::Register(dst) => {
                        if bytes == 16 {
                            self.op(Op::LocalGet(right));
                        } else {
                            if preserve_upper {
                                self.op(Op::LocalGet(self.xmm(dst)));
                            } else {
                                self.op(Op::V128Const(0));
                            }
                            self.op(Op::LocalGet(right));
                            self.op(Op::I8x16Shuffle(std::array::from_fn(|i| {
                                if i < usize::from(bytes) {
                                    16 + i as u8
                                } else {
                                    i as u8
                                }
                            })));
                        }
                        self.op(Op::LocalSet(self.xmm(dst)));
                    }
                    VectorOperand::Memory(address) => {
                        self.vector_store_value(address, bytes, aligned, right, next_pc, exit_depth)
                    }
                }
            }
            ToXmm { dst, src, width } => {
                match src {
                    Location::Register(register) => {
                        self.op(Op::V128Const(0));
                        self.data_register(register, width);
                        self.op(Op::I64x2ReplaceLane(0));
                    }
                    Location::Memory(address) => {
                        self.vector_load_value(address, width.bytes(), false, next_pc, exit_depth)
                    }
                }
                self.op(Op::LocalSet(self.xmm(dst)));
            }
            FromXmm { dst, src, width } => match dst {
                Location::Register(register) => {
                    self.op(Op::LocalGet(self.xmm(src)))
                        .op(Op::I64x2ExtractLane(0));
                    self.narrow(width);
                    self.write_register(register, width);
                }
                Location::Memory(address) => self.vector_store_value(
                    address,
                    width.bytes(),
                    false,
                    self.xmm(src),
                    next_pc,
                    exit_depth,
                ),
            },
            InsertWord {
                dst,
                src,
                immediate,
            } => {
                let destination = self.xmm(dst);
                match src {
                    Location::Register(register) => {
                        self.op(Op::LocalGet(self.xmm(dst)));
                        self.data_register(register, Width::W16);
                        self.op(Op::I32WrapI64);
                    }
                    Location::Memory(address) => {
                        self.vector_load_value(address, 2, false, next_pc, exit_depth);
                        self.op(Op::LocalSet(right))
                            .op(Op::LocalGet(destination))
                            .op(Op::LocalGet(right))
                            .op(Op::I16x8ExtractLaneU(0));
                    }
                }
                self.op(Op::I16x8ReplaceLane(immediate & 7))
                    .op(Op::LocalSet(destination));
            }
            ExtractWord {
                dst,
                src,
                immediate,
            } => {
                self.op(Op::LocalGet(self.xmm(src)))
                    .op(Op::I16x8ExtractLaneU(immediate & 7))
                    .op(Op::I64ExtendI32U);
                self.write_register(RegisterView::low(dst), Width::W32);
            }
            Mask { kind, dst, src } => {
                self.op(Op::LocalGet(self.xmm(src)))
                    .op(match kind {
                        VectorMask::Bytes => Op::I8x16Bitmask,
                        VectorMask::Singles => Op::I32x4Bitmask,
                        VectorMask::Doubles => Op::I64x2Bitmask,
                    })
                    .op(Op::I64ExtendI32U);
                self.write_register(RegisterView::low(dst), Width::W32);
            }
            Binary { kind, dst, src } => {
                self.op(Op::LocalGet(self.xmm(dst))).op(Op::LocalSet(left));
                self.vector_operand(src, 16, true, next_pc, exit_depth);
                self.op(Op::LocalSet(right));
                self.vector_binary(kind, left, right, result);
                self.op(Op::LocalSet(self.xmm(dst)));
            }
            Shuffle {
                kind,
                dst,
                src,
                immediate,
            } => {
                let destination = self.xmm(dst);
                self.op(Op::LocalGet(self.xmm(dst))).op(Op::LocalSet(left));
                self.vector_operand(src, 16, true, next_pc, exit_depth);
                self.op(Op::LocalSet(right));
                let lanes = match kind {
                    VectorShuffle::Dwords => std::array::from_fn(|i| {
                        (((immediate >> (2 * (i / 4))) & 3) * 4) + (i % 4) as u8
                    }),
                    VectorShuffle::LowWords => std::array::from_fn(|i| {
                        if i < 8 {
                            (((immediate >> (2 * (i / 2))) & 3) * 2) + (i % 2) as u8
                        } else {
                            i as u8
                        }
                    }),
                    VectorShuffle::HighWords => std::array::from_fn(|i| {
                        if i >= 8 {
                            8 + (((immediate >> (2 * ((i - 8) / 2))) & 3) * 2) + (i % 2) as u8
                        } else {
                            i as u8
                        }
                    }),
                    VectorShuffle::RawSingles => std::array::from_fn(|i| {
                        if i < 8 {
                            (((immediate >> (2 * (i / 4))) & 3) * 4) + (i % 4) as u8
                        } else {
                            16 + (((immediate >> (2 * (i / 4))) & 3) * 4) + (i % 4) as u8
                        }
                    }),
                    VectorShuffle::RawDoubles => std::array::from_fn(|i| {
                        if i < 8 {
                            (immediate & 1) * 8 + i as u8
                        } else {
                            16 + ((immediate >> 1) & 1) * 8 + (i - 8) as u8
                        }
                    }),
                };
                self.op(Op::LocalGet(
                    if matches!(kind, VectorShuffle::RawSingles | VectorShuffle::RawDoubles) {
                        left
                    } else {
                        right
                    },
                ))
                .op(Op::LocalGet(right))
                .op(Op::I8x16Shuffle(lanes))
                .op(Op::LocalSet(destination));
            }
            Shift { kind, dst, count } => {
                self.op(Op::LocalGet(self.xmm(dst))).op(Op::LocalSet(left));
                self.vector_shift(kind, count, left, right, next_pc, exit_depth);
                self.op(Op::LocalSet(self.xmm(dst)));
            }
        }
    }

    fn zero_extend_dwords(&mut self, local: u32, odd: bool) {
        self.op(Op::LocalGet(local))
            .op(Op::V128Const(0))
            .op(Op::I8x16Shuffle(std::array::from_fn(|i| {
                if i % 8 < 4 {
                    (i / 8 * 8 + i % 8 + usize::from(odd) * 4) as u8
                } else {
                    16
                }
            })));
    }

    fn vector_binary(&mut self, kind: VectorBinary, left: u32, right: u32, result: u32) {
        use VectorBinary::*;
        match kind {
            MulHighWord { signed } => {
                self.op(Op::LocalGet(left))
                    .op(Op::LocalGet(right))
                    .op(if signed {
                        Op::I32x4ExtMulLowI16x8S
                    } else {
                        Op::I32x4ExtMulLowI16x8U
                    })
                    .op(Op::I32Const(16))
                    .op(Op::I32x4ShrU)
                    .op(Op::LocalGet(left))
                    .op(Op::LocalGet(right))
                    .op(if signed {
                        Op::I32x4ExtMulHighI16x8S
                    } else {
                        Op::I32x4ExtMulHighI16x8U
                    })
                    .op(Op::I32Const(16))
                    .op(Op::I32x4ShrU)
                    .op(Op::I16x8NarrowI32x4U);
            }
            MulUnsignedDword => {
                self.zero_extend_dwords(left, false);
                self.zero_extend_dwords(right, false);
                self.op(Op::I64x2Mul);
            }
            SumAbsoluteByteDifferences => {
                self.op(Op::LocalGet(left))
                    .op(Op::LocalGet(right))
                    .op(Op::I8x16MaxU)
                    .op(Op::LocalGet(left))
                    .op(Op::LocalGet(right))
                    .op(Op::I8x16MinU)
                    .op(Op::I8x16Sub)
                    .op(Op::I16x8ExtAddPairwiseI8x16U)
                    .op(Op::I32x4ExtAddPairwiseI16x8U)
                    .op(Op::LocalSet(result));
                self.zero_extend_dwords(result, false);
                self.zero_extend_dwords(result, true);
                self.op(Op::I64x2Add);
            }
            UnpackLow(width) | UnpackHigh(width) => {
                let bytes = usize::from(width.bytes());
                let half = if matches!(kind, UnpackHigh(_)) { 8 } else { 0 };
                self.op(Op::LocalGet(left))
                    .op(Op::LocalGet(right))
                    .op(Op::I8x16Shuffle(std::array::from_fn(|i| {
                        ((i / bytes % 2) * 16 + half + (i / bytes / 2) * bytes + i % bytes) as u8
                    })));
            }
            _ => {
                self.op(Op::LocalGet(if kind == AndNot { right } else { left }))
                    .op(Op::LocalGet(if kind == AndNot { left } else { right }));
                self.op(match kind {
                    And => Op::V128And,
                    AndNot => Op::V128AndNot,
                    Or => Op::V128Or,
                    Xor => Op::V128Xor,
                    Add(Width::W8) => Op::I8x16Add,
                    Add(Width::W16) => Op::I16x8Add,
                    Add(Width::W32) => Op::I32x4Add,
                    Add(Width::W64) => Op::I64x2Add,
                    Sub(Width::W8) => Op::I8x16Sub,
                    Sub(Width::W16) => Op::I16x8Sub,
                    Sub(Width::W32) => Op::I32x4Sub,
                    Sub(Width::W64) => Op::I64x2Sub,
                    SignedSaturatingAdd(Width::W8) => Op::I8x16AddSatS,
                    SignedSaturatingAdd(Width::W16) => Op::I16x8AddSatS,
                    UnsignedSaturatingAdd(Width::W8) => Op::I8x16AddSatU,
                    UnsignedSaturatingAdd(Width::W16) => Op::I16x8AddSatU,
                    SignedSaturatingSub(Width::W8) => Op::I8x16SubSatS,
                    SignedSaturatingSub(Width::W16) => Op::I16x8SubSatS,
                    UnsignedSaturatingSub(Width::W8) => Op::I8x16SubSatU,
                    UnsignedSaturatingSub(Width::W16) => Op::I16x8SubSatU,
                    CompareEqual(Width::W8) => Op::I8x16Eq,
                    CompareEqual(Width::W16) => Op::I16x8Eq,
                    CompareEqual(Width::W32) => Op::I32x4Eq,
                    CompareGreater(Width::W8) => Op::I8x16GtS,
                    CompareGreater(Width::W16) => Op::I16x8GtS,
                    CompareGreater(Width::W32) => Op::I32x4GtS,
                    MinUnsignedByte => Op::I8x16MinU,
                    MaxUnsignedByte => Op::I8x16MaxU,
                    MinSignedWord => Op::I16x8MinS,
                    MaxSignedWord => Op::I16x8MaxS,
                    Average(Width::W8) => Op::I8x16AvgrU,
                    Average(Width::W16) => Op::I16x8AvgrU,
                    MulLowWord => Op::I16x8Mul,
                    MaddSignedWord => Op::I32x4DotI16x8S,
                    PackSigned(Width::W16) => Op::I8x16NarrowI16x8S,
                    PackSigned(Width::W32) => Op::I16x8NarrowI32x4S,
                    PackUnsignedWord => Op::I8x16NarrowI16x8U,
                    _ => unreachable!("decoder admits selected packed widths only"),
                });
            }
        }
    }

    fn vector_shift_op(&mut self, kind: VectorShift) {
        self.op(match kind {
            VectorShift::Left(Width::W16) => Op::I16x8Shl,
            VectorShift::Left(Width::W32) => Op::I32x4Shl,
            VectorShift::Left(Width::W64) => Op::I64x2Shl,
            VectorShift::Right(Width::W16) => Op::I16x8ShrU,
            VectorShift::Right(Width::W32) => Op::I32x4ShrU,
            VectorShift::Right(Width::W64) => Op::I64x2ShrU,
            VectorShift::ArithmeticRight(Width::W16) => Op::I16x8ShrS,
            VectorShift::ArithmeticRight(Width::W32) => Op::I32x4ShrS,
            _ => unreachable!("decoder admits selected lane shifts only"),
        });
    }

    fn vector_overshift(&mut self, kind: VectorShift, width: Width, left: u32) {
        if matches!(kind, VectorShift::ArithmeticRight(_)) {
            self.op(Op::LocalGet(left))
                .op(Op::I32Const(width.bits() as i32 - 1));
            self.vector_shift_op(kind);
        } else {
            self.op(Op::V128Const(0));
        }
    }

    fn vector_shift(
        &mut self,
        kind: VectorShift,
        count: VectorCount,
        left: u32,
        right: u32,
        next_pc: u64,
        exit_depth: u32,
    ) {
        if matches!(kind, VectorShift::ByteLeft | VectorShift::ByteRight) {
            let VectorCount::Immediate(count) = count else {
                unreachable!("byte shift count is immediate")
            };
            if count >= 16 {
                self.op(Op::V128Const(0));
            } else {
                self.op(Op::LocalGet(left))
                    .op(Op::V128Const(0))
                    .op(Op::I8x16Shuffle(std::array::from_fn(|i| {
                        let source = if kind == VectorShift::ByteLeft {
                            i as i32 - i32::from(count)
                        } else {
                            i as i32 + i32::from(count)
                        };
                        if (0..16).contains(&source) {
                            source as u8
                        } else {
                            16
                        }
                    })));
            }
            return;
        }
        let width = match kind {
            VectorShift::Left(width)
            | VectorShift::Right(width)
            | VectorShift::ArithmeticRight(width) => width,
            _ => unreachable!(),
        };
        match count {
            VectorCount::Immediate(count) => {
                if u32::from(count) >= width.bits() {
                    self.vector_overshift(kind, width, left);
                } else {
                    self.op(Op::LocalGet(left))
                        .op(Op::I32Const(i32::from(count)));
                    self.vector_shift_op(kind);
                }
            }
            VectorCount::Vector(operand) => {
                self.vector_operand(operand, 16, true, next_pc, exit_depth);
                self.op(Op::LocalSet(right))
                    .op(Op::LocalGet(right))
                    .op(Op::I64x2ExtractLane(0))
                    .op(Op::LocalSet(RHS))
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
        }
    }
}

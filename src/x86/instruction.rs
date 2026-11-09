use super::context::Segment;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Width {
    W8,
    W16,
    W32,
    W64,
}

impl Width {
    pub fn bits(self) -> u32 {
        match self {
            Self::W8 => 8,
            Self::W16 => 16,
            Self::W32 => 32,
            Self::W64 => 64,
        }
    }

    pub fn bytes(self) -> u8 {
        (self.bits() / 8) as u8
    }

    pub fn mask(self) -> u64 {
        match self {
            Self::W64 => u64::MAX,
            _ => (1u64 << self.bits()) - 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegisterView {
    pub bank: u8,
    pub high_byte: bool,
}

impl RegisterView {
    pub const fn low(bank: u8) -> Self {
        assert!(bank < 16);
        Self {
            bank,
            high_byte: false,
        }
    }

    pub const fn high_byte(bank: u8) -> Self {
        assert!(bank < 4);
        Self {
            bank,
            high_byte: true,
        }
    }

    pub fn shift(self) -> u32 {
        if self.high_byte { 8 } else { 0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operand {
    Register(u8),
    Immediate(u64),
    Memory(Address),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataOperand {
    Register(RegisterView),
    /// the operand-width bit pattern, zero-extended to u64.
    Immediate(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Location {
    Register(RegisterView),
    Memory(Address),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressBase {
    Register(u8),
    /// The containing instruction's completed next_pc.
    NextPc,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AddressIndex {
    pub register: u8,
    /// The effective-address multiplier: 1, 2, 4 or 8.
    pub scale: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Address {
    pub base: AddressBase,
    pub index: Option<AddressIndex>,
    pub displacement: i64,
    pub size: Width,
    pub segment: Segment,
}

impl Default for Address {
    fn default() -> Self {
        Self {
            base: AddressBase::None,
            index: None,
            displacement: 0,
            size: Width::W64,
            segment: Segment::Ds,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alu {
    Add,
    Adc,
    Sub,
    Sbb,
    Cmp,
    And,
    Or,
    Xor,
    Test,
}

impl Alu {
    pub fn writes_result(self) -> bool {
        match self {
            Self::Add | Self::Adc | Self::Sub | Self::Sbb | Self::And | Self::Or | Self::Xor => {
                true
            }
            Self::Cmp | Self::Test => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unary {
    Inc,
    Dec,
    Not,
    Neg,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Carry {
    Clear,
    Set,
    Complement,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StringKind {
    Movs,
    Stos,
    Lods,
    Cmps,
    Scas,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repeat {
    None,
    Count,
    WhileEqual,
    WhileNotEqual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Count {
    Immediate(u8),
    Cl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shift {
    Rol,
    Ror,
    Rcl,
    Rcr,
    Shl,
    Shr,
    Sar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoubleShift {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bit {
    Test,
    Set,
    Reset,
    Complement,
}

impl Bit {
    pub fn writes_result(self) -> bool {
        self != Self::Test
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BitIndex {
    Register(RegisterView),
    Immediate(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryAluOperands {
    MemoryFirst(DataOperand),
    RegisterFirst(RegisterView),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Condition {
    Overflow,
    NotOverflow,
    Below,
    AboveOrEqual,
    Equal,
    NotEqual,
    BelowOrEqual,
    Above,
    Sign,
    NotSign,
    Parity,
    NotParity,
    Less,
    GreaterOrEqual,
    LessOrEqual,
    Greater,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CountCondition {
    Always,
    Equal,
    NotEqual,
    Zero,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorOperand {
    Register(u8),
    Memory(Address),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorBinary {
    And,
    AndNot,
    Or,
    Xor,
    Add(Width),
    Sub(Width),
    SignedSaturatingAdd(Width),
    UnsignedSaturatingAdd(Width),
    SignedSaturatingSub(Width),
    UnsignedSaturatingSub(Width),
    CompareEqual(Width),
    CompareGreater(Width),
    MinUnsignedByte,
    MaxUnsignedByte,
    MinSignedWord,
    MaxSignedWord,
    Average(Width),
    MulLowWord,
    MulHighWord { signed: bool },
    MulUnsignedDword,
    MaddSignedWord,
    SumAbsoluteByteDifferences,
    PackSigned(Width),
    PackUnsignedWord,
    UnpackLow(Width),
    UnpackHigh(Width),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorShuffle {
    Dwords,
    LowWords,
    HighWords,
    RawSingles,
    RawDoubles,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorShift {
    Left(Width),
    Right(Width),
    ArithmeticRight(Width),
    ByteLeft,
    ByteRight,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorCount {
    Immediate(u8),
    Vector(VectorOperand),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorMask {
    Bytes,
    Singles,
    Doubles,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VectorInstruction {
    HalfMove {
        register: u8,
        operand: VectorOperand,
        high: bool,
        store: bool,
    },
    Move {
        register: u8,
        operand: VectorOperand,
        bytes: u8,
        preserve_upper: bool,
        aligned: bool,
        store: bool,
    },
    ToXmm {
        dst: u8,
        src: Location,
        width: Width,
    },
    FromXmm {
        dst: Location,
        src: u8,
        width: Width,
    },
    Binary {
        kind: VectorBinary,
        dst: u8,
        src: VectorOperand,
    },
    Shuffle {
        kind: VectorShuffle,
        dst: u8,
        src: VectorOperand,
        immediate: u8,
    },
    Shift {
        kind: VectorShift,
        dst: u8,
        count: VectorCount,
    },
    InsertWord {
        dst: u8,
        src: Location,
        immediate: u8,
    },
    ExtractWord {
        dst: u8,
        src: u8,
        immediate: u8,
    },
    Mask {
        kind: VectorMask,
        dst: u8,
        src: u8,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FloatInstruction {
    pub op: super::float::Op,
    pub dst: u8,
    pub src: Location,
}

impl FloatInstruction {
    pub fn source_is_gpr(self) -> bool {
        self.op.scalar && self.op.kind == super::float::Kind::IntToFloat
    }
    pub fn destination_is_gpr(self) -> bool {
        self.op.scalar
            && matches!(
                self.op.kind,
                super::float::Kind::FloatToInt | super::float::Kind::TruncToInt
            )
    }
    pub fn writes_flags(self) -> bool {
        matches!(
            self.op.kind,
            super::float::Kind::Comi | super::float::Kind::Ucomi
        )
    }
    pub fn source_bytes(self) -> u8 {
        use super::float::{Format, Kind};
        if self.source_is_gpr() {
            return if self.op.integer64 { 8 } else { 4 };
        }
        if self.op.scalar {
            return if self.op.format == Format::F32 { 4 } else { 8 };
        }
        if self.op.kind == Kind::FloatConvert && self.op.format == Format::F32
            || self.op.kind == Kind::IntToFloat && self.op.format == Format::F64
        {
            8
        } else {
            16
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct X87Instruction {
    pub op: super::x87::Op,
    pub address: Option<Address>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemFlagsKind {
    Push,
    Pop,
    Cli,
    Sti,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SystemFlagsDescriptor {
    pub kind: SystemFlagsKind,
    pub width: Width,
}

impl SystemFlagsDescriptor {
    pub fn encode(self) -> u32 {
        let kind = match self.kind {
            SystemFlagsKind::Push => 0,
            SystemFlagsKind::Pop => 1,
            SystemFlagsKind::Cli => 2,
            SystemFlagsKind::Sti => 3,
        };
        let width = match self.width {
            Width::W16 => 0,
            Width::W32 => 1,
            Width::W64 => 2,
            Width::W8 => panic!("byte FLAGS operand"),
        };
        kind | width << 2
    }

    pub fn pack(self) -> u32 {
        self.encode()
    }

    pub fn try_decode(encoded: u32) -> Option<Self> {
        if encoded & !15 != 0 {
            return None;
        }
        let kind = match encoded & 3 {
            0 => SystemFlagsKind::Push,
            1 => SystemFlagsKind::Pop,
            2 => SystemFlagsKind::Cli,
            _ => SystemFlagsKind::Sti,
        };
        let width = match encoded >> 2 {
            0 => Width::W16,
            1 => Width::W32,
            2 => Width::W64,
            _ => return None,
        };
        if matches!(kind, SystemFlagsKind::Cli | SystemFlagsKind::Sti) && width != Width::W16 {
            return None;
        }
        Some(Self { kind, width })
    }

    pub fn valid_in_mode(self, context: &super::context::ExecutionContext) -> bool {
        match self.kind {
            SystemFlagsKind::Cli | SystemFlagsKind::Sti => self.width == Width::W16,
            SystemFlagsKind::Push | SystemFlagsKind::Pop => {
                self.width == Width::W16
                    || self.width
                        == if context.is_long64() {
                            Width::W64
                        } else {
                            Width::W32
                        }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtectionKind {
    StoreGdt,
    StoreIdt,
    LoadGdt,
    LoadIdt,
    ReadLdt,
    LoadLdt,
    ReadSegment(Segment),
    LoadSegment(Segment),
    LoadFar(Segment),
    Lar,
    Lsl,
    Verr,
    Verw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtectionDescriptor {
    pub kind: ProtectionKind,
    pub width: Width,
    pub memory: bool,
}

impl ProtectionDescriptor {
    pub fn encode(self) -> u32 {
        use ProtectionKind::*;
        let kind = match self.kind {
            StoreGdt => 0,
            StoreIdt => 1,
            LoadGdt => 2,
            LoadIdt => 3,
            ReadLdt => 4,
            LoadLdt => 5,
            ReadSegment(segment) => 6 + segment as u32,
            LoadSegment(segment) => 12 + segment as u32,
            LoadFar(segment) => 18 + segment as u32,
            Lar => 24,
            Lsl => 25,
            Verr => 26,
            Verw => 27,
        };
        let width = match self.width {
            Width::W16 => 0,
            Width::W32 => 1,
            Width::W64 => 2,
            Width::W8 => panic!("byte protection operand"),
        };
        kind | (width << 5) | (u32::from(self.memory) << 7)
    }

    pub fn try_decode(encoded: u32) -> Option<Self> {
        use ProtectionKind::*;
        if encoded & !255 != 0 {
            return None;
        }
        let width = match (encoded >> 5) & 3 {
            0 => Width::W16,
            1 => Width::W32,
            2 => Width::W64,
            _ => return None,
        };
        let memory = encoded & 128 != 0;
        let kind = match encoded & 31 {
            0 => StoreGdt,
            1 => StoreIdt,
            2 => LoadGdt,
            3 => LoadIdt,
            4 => ReadLdt,
            5 => LoadLdt,
            value @ 6..=11 => ReadSegment(Segment::from_id(value - 6)),
            value @ 12..=17 => LoadSegment(Segment::from_id(value - 12)),
            value @ 18..=23 => LoadFar(Segment::from_id(value - 18)),
            24 => Lar,
            25 => Lsl,
            26 => Verr,
            27 => Verw,
            _ => return None,
        };
        let valid = match kind {
            StoreGdt | StoreIdt | LoadGdt | LoadIdt => memory,
            ReadLdt | ReadSegment(_) => !memory || width == Width::W16,
            LoadLdt | Verr | Verw => width == Width::W16,
            LoadSegment(segment) => segment != Segment::Cs && width == Width::W16,
            LoadFar(segment) => {
                memory
                    && segment != Segment::Cs
                    && (width != Width::W64 || !matches!(segment, Segment::Ds | Segment::Es))
            }
            Lar | Lsl => true,
        };
        valid.then_some(Self {
            kind,
            width,
            memory,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtectionInstruction {
    pub kind: ProtectionKind,
    pub operand: Location,
    pub register: u8,
    pub width: Width,
}

impl ProtectionInstruction {
    pub fn descriptor(self) -> ProtectionDescriptor {
        ProtectionDescriptor {
            kind: self.kind,
            width: self.width,
            memory: matches!(self.operand, Location::Memory(_)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FarKind {
    Call,
    Jump,
    Return,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FarDescriptor {
    pub kind: FarKind,
    pub width: Width,
    pub memory: bool,
}

impl FarDescriptor {
    pub fn encode(self) -> u32 {
        let kind = match self.kind {
            FarKind::Call => 0,
            FarKind::Jump => 1,
            FarKind::Return => 2,
        };
        let width = match self.width {
            Width::W16 => 0,
            Width::W32 => 1,
            Width::W64 => 2,
            Width::W8 => panic!("byte far operand"),
        };
        kind | (width << 2) | (u32::from(self.memory) << 4)
    }
    pub fn try_decode(encoded: u32) -> Option<Self> {
        if encoded & !31 != 0 {
            return None;
        }
        let kind = match encoded & 3 {
            0 => FarKind::Call,
            1 => FarKind::Jump,
            2 => FarKind::Return,
            _ => return None,
        };
        let width = match (encoded >> 2) & 3 {
            0 => Width::W16,
            1 => Width::W32,
            2 => Width::W64,
            _ => return None,
        };
        let memory = encoded & 16 != 0;
        if kind == FarKind::Return && memory {
            return None;
        }
        Some(Self {
            kind,
            width,
            memory,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FarOperand {
    Immediate { selector: u16, offset: u64 },
    Memory(Address),
    Return { cleanup: u16 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FarInstruction {
    pub kind: FarKind,
    pub width: Width,
    pub operand: FarOperand,
}

impl FarInstruction {
    pub fn descriptor(self) -> FarDescriptor {
        FarDescriptor {
            kind: self.kind,
            width: self.width,
            memory: matches!(self.operand, FarOperand::Memory(_)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    SystemFlags(SystemFlagsDescriptor),
    PopSs {
        width: Width,
    },
    Far(FarInstruction),
    Protection(ProtectionInstruction),
    MaskedStore {
        data: u8,
        mask: u8,
        mmx: bool,
        address: Address,
    },
    Clflush {
        address: Address,
    },
    Mmx {
        op: super::mmx::Op,
        address: Option<Address>,
    },
    NumericImage {
        op: super::numeric_images::ImageOp,
        address: Address,
    },
    X87(X87Instruction),
    Float(FloatInstruction),
    Mxcsr {
        address: Address,
        store: bool,
    },
    Vector(VectorInstruction),
    Nop,
    Exchange {
        dst: Location,
        src: RegisterView,
        width: Width,
    },
    Xadd {
        dst: Location,
        src: RegisterView,
        width: Width,
    },
    CompareExchange {
        dst: Location,
        src: RegisterView,
        width: Width,
    },
    CompareExchange8b {
        address: Address,
    },
    Direction {
        set: bool,
    },
    String {
        kind: StringKind,
        width: Width,
        address_width: Width,
        source_segment: Segment,
        repeat: Repeat,
    },
    Mov {
        dst: RegisterView,
        src: DataOperand,
        width: Width,
    },
    Lea {
        dst: RegisterView,
        address: Address,
        width: Width,
    },
    Load {
        dst: RegisterView,
        address: Address,
        width: Width,
    },
    Store {
        src: DataOperand,
        address: Address,
        width: Width,
    },
    Alu {
        kind: Alu,
        /// First register operand; Cmp and Test do not write it.
        dst: RegisterView,
        src: DataOperand,
        width: Width,
    },
    MemoryAlu {
        kind: Alu,
        address: Address,
        operands: MemoryAluOperands,
        width: Width,
    },
    Unary {
        kind: Unary,
        dst: Location,
        width: Width,
    },
    Multiply {
        signed: bool,
        src: Location,
        width: Width,
    },
    Imul {
        dst: RegisterView,
        src: Location,
        immediate: Option<u64>,
        width: Width,
    },
    Divide {
        signed: bool,
        src: Location,
        width: Width,
    },
    Carry {
        kind: Carry,
    },
    Lahf,
    Sahf,
    Shift {
        kind: Shift,
        dst: Location,
        count: Count,
        width: Width,
    },
    DoubleShift {
        kind: DoubleShift,
        dst: Location,
        src: RegisterView,
        count: Count,
        width: Width,
    },
    Bit {
        kind: Bit,
        dst: Location,
        index: BitIndex,
        width: Width,
    },
    Scan {
        reverse: bool,
        dst: RegisterView,
        src: Location,
        width: Width,
    },
    Bswap {
        dst: RegisterView,
        width: Width,
    },
    Extend {
        dst: RegisterView,
        src: Location,
        source_width: Width,
        width: Width,
        signed: bool,
    },
    SignHigh {
        width: Width,
    },
    Setcc {
        dst: Location,
        condition: Condition,
    },
    Cmov {
        dst: RegisterView,
        src: Location,
        width: Width,
        condition: Condition,
    },
    Push {
        src: Operand,
        width: Width,
    },
    Pop {
        dst: u8,
        width: Width,
    },
    PopMemory {
        address: Address,
        width: Width,
    },
    Leave {
        width: Width,
    },
    Call {
        /// Absolute guest target, also for a decoded relative CALL.
        target: Operand,
        width: Width,
    },
    JumpRegister {
        target: u8,
        width: Width,
    },
    JumpMemory {
        address: Address,
        width: Width,
    },
    Return {
        cleanup: u16,
        width: Width,
    },
    Jump {
        target: u64,
    },
    Jcc {
        condition: Condition,
        target: u64,
    },
    CountBranch {
        condition: CountCondition,
        count_width: Width,
        target: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Instruction {
    pub pc: u64,
    pub next_pc: u64,
    pub operation: Operation,
}

impl Instruction {
    pub fn encoded_len(&self) -> u32 {
        // Lengths are at most 15; low32 keeps both EIP32 and RIP64 wrap exact.
        self.next_pc.wrapping_sub(self.pc) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::{Alu, Width};

    #[test]
    fn compare_and_test_have_no_operand_write() {
        for kind in [
            Alu::Add,
            Alu::Adc,
            Alu::Sub,
            Alu::Sbb,
            Alu::And,
            Alu::Or,
            Alu::Xor,
        ] {
            assert!(kind.writes_result(), "{kind:?}");
        }
        for kind in [Alu::Cmp, Alu::Test] {
            assert!(!kind.writes_result(), "{kind:?}");
        }
    }

    #[test]
    fn operand_widths_match_the_selected_data_forms() {
        for (width, bits, bytes, mask) in [
            (Width::W8, 8, 1, 0xff),
            (Width::W16, 16, 2, 0xffff),
            (Width::W32, 32, 4, 0xffff_ffff),
            (Width::W64, 64, 8, u64::MAX),
        ] {
            assert_eq!(
                (width.bits(), width.bytes(), width.mask()),
                (bits, bytes, mask)
            );
        }
    }
}

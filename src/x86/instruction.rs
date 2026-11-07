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
pub enum Operation {
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

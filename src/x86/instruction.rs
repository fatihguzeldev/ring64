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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alu {
    Add,
    Sub,
    Cmp,
    And,
    Or,
    Xor,
    Test,
}

impl Alu {
    pub fn writes_result(self) -> bool {
        match self {
            Self::Add | Self::Sub | Self::And | Self::Or | Self::Xor => true,
            Self::Cmp | Self::Test => false,
        }
    }
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
pub enum Operation {
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
    },
    Pop {
        dst: u8,
    },
    Call {
        /// Absolute guest target, also for a decoded relative CALL.
        target: Operand,
    },
    JumpRegister {
        target: u8,
    },
    Return {
        cleanup: u16,
    },
    Jump {
        target: u64,
    },
    Jcc {
        condition: Condition,
        target: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Instruction {
    pub pc: u64,
    pub next_pc: u64,
    pub operation: Operation,
}

#[cfg(test)]
mod tests {
    use super::{Alu, Width};

    #[test]
    fn compare_and_test_have_no_operand_write() {
        for kind in [Alu::Add, Alu::Sub, Alu::And, Alu::Or, Alu::Xor] {
            assert!(kind.writes_result(), "{kind:?}");
        }
        for kind in [Alu::Cmp, Alu::Test] {
            assert!(!kind.writes_result(), "{kind:?}");
        }
    }

    #[test]
    fn operand_widths_match_the_selected_data_forms() {
        assert_eq!((Width::W32.bits(), Width::W32.bytes()), (32, 4));
        assert_eq!((Width::W64.bits(), Width::W64.bytes()), (64, 8));
    }
}

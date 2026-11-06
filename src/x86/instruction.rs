#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Width {
    W32,
    W64,
}

impl Width {
    pub fn bits(self) -> u32 {
        match self {
            Self::W32 => 32,
            Self::W64 => 64,
        }
    }

    pub fn bytes(self) -> u8 {
        (self.bits() / 8) as u8
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operand {
    Register(u8),
    /// The operand-width bit pattern, zero-extended to u64 for W32.
    Immediate(u64),
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
    MemoryFirst(Operand),
    RegisterFirst(u8),
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
        dst: u8,
        src: Operand,
        width: Width,
    },
    Lea {
        dst: u8,
        address: Address,
        width: Width,
    },
    Load {
        dst: u8,
        address: Address,
        width: Width,
    },
    Store {
        src: u8,
        address: Address,
        width: Width,
    },
    Alu {
        kind: Alu,
        /// First register operand; Cmp and Test do not write it.
        dst: u8,
        src: Operand,
        width: Width,
    },
    MemoryAlu {
        kind: Alu,
        address: Address,
        operands: MemoryAluOperands,
        width: Width,
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

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
pub struct Address {
    pub base: u8,
    pub displacement: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alu {
    Add,
    Sub,
    Cmp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Mov {
        dst: u8,
        src: Operand,
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
        dst: u8,
        src: Operand,
        width: Width,
    },
    Jump {
        target: u64,
    },
    Jnz {
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
    use super::Width;

    #[test]
    fn operand_widths_match_the_selected_data_forms() {
        assert_eq!((Width::W32.bits(), Width::W32.bytes()), (32, 4));
        assert_eq!((Width::W64.bits(), Width::W64.bytes()), (64, 8));
    }
}

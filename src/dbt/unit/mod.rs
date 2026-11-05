use crate::x86::instruction::Instruction;

pub(crate) struct Unit {
    pub instructions: Vec<Instruction>,
    pub block_count: usize,
    pub source_bytes: usize,
}

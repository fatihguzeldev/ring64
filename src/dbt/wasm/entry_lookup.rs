use std::collections::BTreeMap;
use wasm_encoder::{BlockType, Function, Instruction as Op, ValType};

pub(super) fn emit(entries: &BTreeMap<u64, u32>) -> Function {
    let entries: Vec<_> = entries.iter().map(|(&pc, &index)| (pc, index)).collect();
    let mut body = Function::new([]);
    lookup_tree(&mut body, &entries);
    body.instruction(&Op::End);
    body
}

fn lookup_tree(body: &mut Function, entries: &[(u64, u32)]) {
    if entries.is_empty() {
        body.instruction(&Op::I32Const(-1));
        return;
    }
    let middle = entries.len() / 2;
    let (pc, index) = entries[middle];
    body.instruction(&Op::LocalGet(0));
    body.instruction(&Op::I64Const(pc as i64));
    body.instruction(&Op::I64Eq);
    body.instruction(&Op::If(BlockType::Result(ValType::I32)));
    body.instruction(&Op::I32Const(index as i32));
    body.instruction(&Op::Else);
    if entries.len() == 1 {
        body.instruction(&Op::I32Const(-1));
    } else {
        body.instruction(&Op::LocalGet(0));
        body.instruction(&Op::I64Const(pc as i64));
        body.instruction(&Op::I64LtU);
        body.instruction(&Op::If(BlockType::Result(ValType::I32)));
        lookup_tree(body, &entries[..middle]);
        body.instruction(&Op::Else);
        lookup_tree(body, &entries[middle + 1..]);
        body.instruction(&Op::End);
    }
    body.instruction(&Op::End);
}

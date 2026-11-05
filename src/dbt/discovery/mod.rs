use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::memory::{Image, canonical48};
use crate::x86::{decode::decode, instruction::Operation};

use super::{CompileError, Limits, unit::Unit};

pub(crate) fn discover(image: &Image, entry: u64, limits: Limits) -> Result<Unit, CompileError> {
    let mut pending = VecDeque::from([entry]);
    let mut visited = BTreeSet::new();
    let mut instructions = BTreeMap::new();
    let mut source = BTreeSet::new();
    while let Some(pc) = pending.pop_front() {
        if instructions.len() >= limits.max_instructions as usize {
            break;
        }
        if !visited.insert(pc) {
            continue;
        }
        let Ok(instruction) = decode(pc, |address| image.fetch(address)) else {
            // A future diagnostic is a frontier, never an early guest exit.
            continue;
        };
        let length = instruction.next_pc.wrapping_sub(pc);
        let bytes: Vec<_> = (0..length).map(|offset| pc.wrapping_add(offset)).collect();
        let additional = bytes
            .iter()
            .filter(|address| !source.contains(*address))
            .count();
        if source.len() + additional > limits.max_source_bytes as usize {
            continue;
        }
        source.extend(bytes);
        match instruction.operation {
            Operation::Jump { target } => {
                if canonical48(target) {
                    pending.push_back(target);
                }
            }
            Operation::Jcc { target, .. } => {
                pending.push_back(instruction.next_pc);
                if canonical48(target) {
                    pending.push_back(target);
                }
            }
            _ => pending.push_back(instruction.next_pc),
        }
        instructions.insert(pc, instruction);
    }
    if !instructions.contains_key(&entry) {
        return Err(CompileError::Resource);
    }
    let mut leaders = BTreeSet::from([entry]);
    for instruction in instructions.values() {
        match instruction.operation {
            Operation::Jump { target } => {
                leaders.insert(target);
            }
            Operation::Jcc { target, .. } => {
                leaders.insert(target);
                leaders.insert(instruction.next_pc);
            }
            _ => {}
        }
    }
    Ok(Unit {
        block_count: leaders
            .iter()
            .filter(|pc| instructions.contains_key(pc))
            .count(),
        instructions: instructions.into_values().collect(),
        source_bytes: source.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(bytes: &[u8]) -> Image {
        Image::new(0x1000, bytes.to_vec(), 0x8000, vec![0; 32]).unwrap()
    }

    fn limits() -> Limits {
        Limits {
            max_instructions: 64,
            max_source_bytes: 256,
            max_artifact_bytes: 65536,
        }
    }

    #[test]
    fn discovers_loop_and_fallthrough_without_executing_future_failure() {
        let code = image(&[
            0xb8, 0, 0, 0, 0, 0xb9, 3, 0, 0, 0, 0x48, 0x01, 0xc8, 0x48, 0x83, 0xe9, 1, 0x75, 0xf7,
            0x48, 0x89, 0x03,
        ]);
        let unit = discover(&code, 0x1000, limits()).unwrap();
        assert_eq!(
            unit.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0x1000, 0x1005, 0x100a, 0x100d, 0x1011, 0x1013]
        );
        assert_eq!(unit.block_count, 3);
        assert_eq!(unit.source_bytes, 22);
    }

    #[test]
    fn overlapping_entries_count_distinct_source_bytes() {
        let code = image(&[0x75, 1, 0xb8, 0xb9, 3, 0, 0, 0, 0x90]);
        let unit = discover(&code, 0x1000, limits()).unwrap();
        assert_eq!(
            unit.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0x1000, 0x1002, 0x1003]
        );
        assert_eq!(unit.source_bytes, 8);
        assert_eq!(unit.block_count, 3);
    }

    #[test]
    fn bounds_admit_a_prefix_and_refuse_an_unadmittable_first_instruction() {
        let code = image(&[0xb8, 1, 0, 0, 0, 0xb9, 2, 0, 0, 0]);
        let unit = discover(
            &code,
            0x1000,
            Limits {
                max_instructions: 1,
                ..limits()
            },
        )
        .unwrap();
        assert_eq!(unit.instructions.len(), 1);
        let result = discover(
            &code,
            0x1000,
            Limits {
                max_source_bytes: 4,
                ..limits()
            },
        );
        assert!(matches!(result, Err(CompileError::Resource)));
    }
}

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::memory::{Access, Image, canonical48};
use crate::x86::{
    context::{AccessFailure, ExecutionContext, Segment},
    decode::DecodeError,
    instruction::{Operand, Operation},
};

use super::{CompileError, Limits, SourceRange, unit::Unit};

#[cfg(test)]
pub(crate) fn discover(image: &Image, entry: u64, limits: Limits) -> Result<Unit, CompileError> {
    discover_with_context(image, &ExecutionContext::default(), entry, limits)
}

#[cfg(test)]
pub(crate) fn discover_with_context(
    image: &Image,
    context: &ExecutionContext,
    entry: u64,
    limits: Limits,
) -> Result<Unit, CompileError> {
    discover_with_profile(image, context, None, entry, limits)
}

pub(crate) fn discover_with_profile(
    image: &Image,
    context: &ExecutionContext,
    paging: Option<&crate::x86::paging::State>,
    entry: u64,
    limits: Limits,
) -> Result<Unit, CompileError> {
    let mut pending = VecDeque::from([entry]);
    let mut visited = BTreeSet::new();
    let mut instructions = BTreeMap::new();
    let mut source = BTreeSet::new();
    let mut linear_source = BTreeSet::new();
    let mut read_dependencies = BTreeSet::new();
    let identity_source = context.is_long64() && paging.is_none();
    while let Some(pc) = pending.pop_front() {
        if instructions.len() >= limits.max_instructions as usize {
            break;
        }
        if !visited.insert(pc) {
            continue;
        }
        let mut fetched = Vec::new();
        let mut table_bytes = Vec::new();
        let Ok(instruction) =
            crate::x86::decode::decode_with_profile(pc, context, paging.is_some(), |offset| {
                // Long64 CS offsets are linear; fetch already checks the full byte span.
                if identity_source {
                    return image.fetch(offset).map_err(DecodeError::Fetch);
                }
                let linear = context
                    .translate(offset, 1, Segment::Cs, Access::Execute, false)
                    .map_err(|failure| match failure {
                        AccessFailure::Segment(fault) => DecodeError::Segment(fault),
                        AccessFailure::Linear(fault) => DecodeError::Fetch(fault),
                        AccessFailure::Paging(fault) => DecodeError::Paging(fault),
                    })?;
                if let Some(paging) = paging {
                    let request = crate::x86::paging::walk::Request {
                        linear,
                        access: Access::Execute,
                        class: crate::x86::paging::walk::AccessClass::operand(context.cpl(), false),
                    };
                    let translated = crate::x86::paging::walk::peek(image, paging, request)
                        .map_err(DecodeError::Paging)?;
                    let byte = image
                        .physical_fetch(translated.physical)
                        .map_err(DecodeError::Fetch)?;
                    fetched.push(translated.physical);
                    for entry in translated.entries() {
                        table_bytes.extend(*entry..*entry + u64::from(translated.entry_width));
                    }
                    return Ok(byte);
                }
                let byte = image.fetch(linear).map_err(DecodeError::Fetch)?;
                fetched.push(linear);
                Ok(byte)
            })
        else {
            // A future diagnostic is a frontier, never an early guest exit.
            continue;
        };
        let length = u64::from(instruction.encoded_len());
        let bytes: Vec<_> = (0..length).map(|offset| pc.wrapping_add(offset)).collect();
        let additional = bytes
            .iter()
            .filter(|address| !source.contains(*address))
            .count();
        if source.len() + additional > limits.max_source_bytes as usize {
            continue;
        }
        source.extend(bytes);
        linear_source.extend(fetched);
        read_dependencies.extend(table_bytes);
        match instruction.operation {
            Operation::Jump { target } => {
                if !context.is_long64() || canonical48(target) {
                    pending.push_back(target);
                }
            }
            Operation::Jcc { target, .. } | Operation::CountBranch { target, .. } => {
                pending.push_back(instruction.next_pc);
                if !context.is_long64() || canonical48(target) {
                    pending.push_back(target);
                }
            }
            Operation::Call { target, .. } => {
                pending.push_back(instruction.next_pc);
                if let Operand::Immediate(target) = target
                    && (!context.is_long64() || canonical48(target))
                {
                    pending.push_back(target);
                }
            }
            Operation::JumpRegister { .. }
            | Operation::JumpMemory { .. }
            | Operation::Return { .. }
            | Operation::Far(_)
            | Operation::FastSystem(_)
            | Operation::Halt => {}
            Operation::SoftwareEvent(event) => {
                if event.kind == crate::x86::instruction::SoftwareEventKind::Into {
                    pending.push_back(instruction.next_pc);
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
            Operation::Jcc { target, .. } | Operation::CountBranch { target, .. } => {
                leaders.insert(target);
                leaders.insert(instruction.next_pc);
            }
            Operation::Call { target, .. } => {
                leaders.insert(instruction.next_pc);
                if let Operand::Immediate(target) = target {
                    leaders.insert(target);
                }
            }
            Operation::SoftwareEvent(event)
                if event.kind == crate::x86::instruction::SoftwareEventKind::Into =>
            {
                leaders.insert(instruction.next_pc);
            }
            _ => {}
        }
    }
    let mut source_ranges: Vec<SourceRange> = Vec::new();
    for address in if identity_source {
        &source
    } else {
        &linear_source
    } {
        if let Some(last) = source_ranges.last_mut()
            && u128::from(last.start) + u128::from(last.length) == u128::from(*address)
        {
            last.length += 1;
        } else {
            source_ranges.push(SourceRange {
                start: *address,
                length: 1,
            });
        }
    }
    Ok(Unit {
        context: context.clone(),
        block_count: leaders
            .iter()
            .filter(|pc| instructions.contains_key(pc))
            .count(),
        instructions: instructions.into_values().collect(),
        source_bytes: source.len(),
        source_ranges,
        read_dependencies: ranges(&read_dependencies),
    })
}

fn ranges(bytes: &BTreeSet<u64>) -> Vec<SourceRange> {
    let mut ranges: Vec<SourceRange> = Vec::new();
    for &address in bytes {
        if let Some(last) = ranges.last_mut()
            && u128::from(last.start) + u128::from(last.length) == u128::from(address)
        {
            last.length += 1;
        } else {
            ranges.push(SourceRange {
                start: address,
                length: 1,
            });
        }
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MappingInput, MemoryLimits, Permissions};
    use serde_json::json;

    fn context(cs_base: u32) -> ExecutionContext {
        let mut segments = serde_json::Map::new();
        for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
            segments.insert(
                name.into(),
                json!({
                    "base":format!("0x{:x}",if name == "cs" { cs_base } else { 0 }),
                    "limit":u32::MAX,"default32":true,"usable":true,
                    "type":if name == "cs" { "readable-code" } else { "read-write" }
                }),
            );
        }
        ExecutionContext::from_json(&json!({"mode":"protected","segments":segments})).unwrap()
    }

    fn split_image(code: &[u8], high_offset: u32) -> Image {
        Image::mapped(
            vec![("code".into(), code.to_vec())],
            [(u32::MAX, high_offset, 1), (0, 0, high_offset)]
                .into_iter()
                .map(|(base, offset, length)| MappingInput {
                    base: u64::from(base),
                    backing: "code".into(),
                    offset,
                    length,
                    permissions: Permissions {
                        read: true,
                        write: true,
                        execute: true,
                    },
                })
                .collect(),
            MemoryLimits {
                max_backing_bytes: 32,
                max_backings: 1,
                max_mappings: 2,
            },
        )
        .unwrap()
    }

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
    fn calls_discover_static_continuations_without_guessing_dynamic_targets() {
        let direct = image(&[
            0xe8, 11, 0, 0, 0, 0xb9, 1, 0, 0, 0, 0xeb, 20, 0, 0, 0, 0, 0xba, 2, 0, 0, 0, 0xc3,
        ]);
        let unit = discover(&direct, 0x1000, limits()).unwrap();
        assert_eq!(
            unit.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0x1000, 0x1005, 0x100a, 0x1010, 0x1015]
        );
        assert_eq!(unit.source_bytes, 18);
        assert_eq!(unit.block_count, 3);

        let indirect = image(&[0xff, 0xd0, 0xb9, 1, 0, 0, 0, 0xc3, 0xb8, 2, 0, 0, 0, 0xc3]);
        let unit = discover(&indirect, 0x1000, limits()).unwrap();
        assert_eq!(
            unit.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0x1000, 0x1002, 0x1007]
        );
        assert_eq!(unit.source_bytes, 8);
        assert_eq!(unit.block_count, 2);
        for code in [
            vec![0xc3, 0xb8, 1, 0, 0, 0],
            vec![0xff, 0xe0, 0xb8, 1, 0, 0, 0],
        ] {
            let unit = discover(&image(&code), 0x1000, limits()).unwrap();
            assert_eq!(unit.instructions.len(), 1);
        }
    }

    #[test]
    fn memory_transfers_never_discover_data_targets_and_count_branches_have_two_edges() {
        let call = discover(&image(&[0xff, 0x10, 0xc3, 0x82, 0xf5]), 0x1000, limits()).unwrap();
        assert_eq!(
            call.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0x1000, 0x1002]
        );
        assert_eq!(call.source_bytes, 3);
        assert_eq!(call.block_count, 2);
        let jump = discover(&image(&[0xff, 0x20, 0xf5]), 0x1000, limits()).unwrap();
        assert_eq!(jump.instructions.len(), 1);
        assert_eq!(jump.source_bytes, 2);
        for opcode in 0xe0..=0xe3 {
            let branch = discover(
                &image(&[opcode, 2, 0xf5, 0x82, 0xf5, 0x82]),
                0x1000,
                limits(),
            )
            .unwrap();
            assert_eq!(
                branch.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
                [0x1000, 0x1002, 0x1004]
            );
            assert_eq!(branch.source_bytes, 4);
            assert_eq!(branch.block_count, 3);
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
        let code = image(&[0x75, 1, 0xb8, 0xb9, 3, 0, 0, 0, 0x60]);
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

    #[test]
    fn source_ranges_retain_exact_guest_bytes_without_baking_future_diagnostics() {
        let mut bytes = vec![0x82; 32];
        bytes[..2].copy_from_slice(&[0xeb, 14]);
        bytes[16..21].copy_from_slice(&[0xb8, 1, 0, 0, 0]);
        let unit = discover(&image(&bytes), 0x1000, limits()).unwrap();
        assert_eq!(unit.source_bytes, 7);
        assert_eq!(
            unit.source_ranges,
            [
                SourceRange {
                    start: 0x1000,
                    length: 2
                },
                SourceRange {
                    start: 0x1010,
                    length: 5
                },
            ]
        );

        let overlapping = discover(
            &image(&[0x75, 1, 0xb8, 0xb9, 3, 0, 0, 0x82, 0x82]),
            0x1000,
            limits(),
        )
        .unwrap();
        assert_eq!(
            overlapping.source_ranges,
            [SourceRange {
                start: 0x1000,
                length: 8
            }]
        );
        let top = Image::new(u64::MAX - 4, vec![0xb8, 1, 0, 0, 0], 0x8000, vec![0; 8]).unwrap();
        assert_eq!(
            discover(&top, u64::MAX - 4, limits())
                .unwrap()
                .source_ranges,
            [SourceRange {
                start: u64::MAX - 4,
                length: 5
            }]
        );
    }

    #[test]
    fn logical_entries_remain_distinct_from_translated_source_dependencies() {
        let code = Image::new(0x9000, vec![0xb8, 1, 0, 0, 0, 0xc3], 0x10000, vec![0; 8]).unwrap();
        let unit = discover_with_context(&code, &context(0x8000), 0x1000, limits()).unwrap();
        assert_eq!(
            unit.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0x1000, 0x1005]
        );
        assert_eq!(unit.source_bytes, 6);
        assert_eq!(
            unit.source_ranges,
            [SourceRange {
                start: 0x9000,
                length: 6
            }]
        );
        assert_eq!(unit.context, context(0x8000));
    }

    #[test]
    fn long64_segment_bases_do_not_redirect_instruction_sources() {
        let image = image(&[0x64, 0xb8, 1, 0, 0, 0, 0xf5]);
        let context = ExecutionContext::from_json(&json!({
            "mode":"long64","fsBase":"0x100000000","gsBase":"0xffff800000000000"
        }))
        .unwrap();
        let unit = discover_with_context(&image, &context, 0x1000, limits()).unwrap();
        assert_eq!(
            unit.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0x1000, 0x1006]
        );
        assert_eq!(unit.source_bytes, 7);
        assert_eq!(
            unit.source_ranges,
            [SourceRange {
                start: 0x1000,
                length: 7
            }]
        );
        assert_eq!(unit.context, context);
    }

    #[test]
    fn translated_fetch_wrap_splits_linear_dependencies_without_changing_source_budget() {
        // Logical offsets 0..4 map to ffffffff,0,1,2,3.
        let image = split_image(&[1, 2, 3, 4, 0xb8], 4);
        let context = context(u32::MAX);
        let unit = discover_with_context(
            &image,
            &context,
            0,
            Limits {
                max_source_bytes: 5,
                ..limits()
            },
        )
        .unwrap();
        assert_eq!(unit.instructions.len(), 1);
        assert_eq!(unit.instructions[0].next_pc, 5);
        assert_eq!(unit.source_bytes, 5);
        assert_eq!(
            unit.source_ranges,
            [
                SourceRange {
                    start: 0,
                    length: 4
                },
                SourceRange {
                    start: u64::from(u32::MAX),
                    length: 1
                }
            ]
        );
        assert!(matches!(
            discover_with_context(
                &image,
                &context,
                0,
                Limits {
                    max_source_bytes: 4,
                    ..limits()
                }
            ),
            Err(CompileError::Resource)
        ));
    }

    #[test]
    fn eip_wrap_advances_to_a_logical_entry_without_wrapping_required_fetch_bytes() {
        let image = split_image(&[0xb8, 1, 0, 0, 0, 0x40], 5);
        let unit =
            discover_with_context(&image, &context(0), u64::from(u32::MAX), limits()).unwrap();
        assert_eq!(
            unit.instructions.iter().map(|i| i.pc).collect::<Vec<_>>(),
            [0, u64::from(u32::MAX)]
        );
        assert_eq!(unit.instructions[1].next_pc, 0);
        assert_eq!(unit.source_bytes, 6);
        assert_eq!(
            unit.source_ranges,
            [
                SourceRange {
                    start: 0,
                    length: 5
                },
                SourceRange {
                    start: u64::from(u32::MAX),
                    length: 1
                }
            ]
        );

        let crossing = split_image(&[1, 0, 0, 0, 0, 0xb8], 5);
        assert!(matches!(
            discover_with_context(&crossing, &context(0), u64::from(u32::MAX), limits()),
            Err(CompileError::Resource)
        ));
    }
    #[test]
    fn far_transfers_stop_discovery_before_old_context_continuations_or_data_targets() {
        for code in [
            vec![0xcb, 0x90, 0x90],
            vec![0xff, 0x1b, 0x90],
            vec![0xff, 0x2b, 0x90],
        ] {
            let u = discover(&image(&code), 0x1000, limits()).unwrap();
            assert_eq!(u.instructions.len(), 1);
            assert!(matches!(u.instructions[0].operation, Operation::Far(_)));
            assert_eq!(u.source_bytes, if code[0] == 0xcb { 1 } else { 2 });
        }
        let u = discover_with_context(
            &image(&[0xea, 0x07, 0x10, 0, 0, 8, 0, 0x90]),
            &context(0),
            0x1000,
            limits(),
        )
        .unwrap();
        assert_eq!(u.instructions.len(), 1);
        assert_eq!(u.source_bytes, 7);
    }
}

use super::*;
use crate::x86::instruction::{DataOperand, Operation, RegisterView, Width};
use crate::x86::paging::walk::{Failure, PhysicalPhase, physical_counts};

const PC: u64 = 0x1000;
const RF: u64 = 0x10002;

fn fixture(family: &str, warm: bool, executable: bool) -> Vec<u8> {
    let mut bytes = vec![0xa5; 0xa000];
    let (entries, bank) = match family {
        "ia32e" => (
            vec![
                (0x1000, 0x2007u64, 8),
                (0x2000, 0x3007, 8),
                (0x3000, 0x4007, 8),
                (0x4008, 0x9007, 8),
            ],
            serde_json::json!({"cr0":"0x80000033","cr2":"0xdead","cr3":"0x1000","cr4":"0x628","efer":"0x500"}),
        ),
        "legacy32" => (
            vec![(0x1000, 0x2007, 4), (0x2004, 0x9007, 4)],
            serde_json::json!({"cr0":"0x80000033","cr2":"0xdead","cr3":"0x1000","cr4":"0x608","efer":"0x0"}),
        ),
        "pae" => (
            vec![(0x2000, 0x3007, 8), (0x3008, 0x9007, 8)],
            // Root RAM remains 0xa5: only this captured quartet is authoritative.
            serde_json::json!({"cr0":"0x80000033","cr2":"0xdead","cr3":"0x1000","cr4":"0x628","efer":"0x0","pdpte":["0x2001","0x0","0x0","0x0"]}),
        ),
        "pg0" => (
            vec![],
            serde_json::json!({"cr0":"0x33","cr2":"0xdead","cr3":"0xdead000","cr4":"0x628","efer":"0x100"}),
        ),
        _ => panic!("unknown literal paging family"),
    };
    let code = if family == "pg0" { 0x1000 } else { 0x9000 };
    bytes[code..code + 3].copy_from_slice(&[0x66, 0x89, 0xc0]);
    for &(address, word, width) in &entries {
        let word = word | if warm { 0x20 } else { 0 };
        bytes[address..address + width].copy_from_slice(&word.to_le_bytes()[..width]);
    }
    let mut context = ExecutionContext::default().to_json();
    context["mode"] = serde_json::json!("protected");
    context["segments"]["cs"]["long"] = serde_json::json!(false);
    context["segments"]["cs"]["default32"] = serde_json::json!(true);
    let config = serde_json::json!({
        "memoryModel":if family == "ia32e" { "ia32e-paged" } else { "physical" },
        "context":context,"paging":bank,
        "memoryLimits":{"maxBackingBytes":40960,"maxBackings":1,"maxMappings":1},
        "backings":[{"id":"ram","length":40960}],
        "mappings":[{"base":"0x0","backing":"ram","offset":0,"length":40960,
            "permissions":{"read":true,"write":true,"execute":executable}}]
    });
    let length = mapped_input(config, &bytes);
    assert_eq!(mapped::core_init_mapped(PC, length), 0, "{family}");
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        let state = &mut *bridge.core.as_mut().unwrap().state.get();
        state.registers[0] = 0x1122334455667788;
        state.flags = RF;
    });
    for &(address, word, width) in &entries {
        bytes[address..address + width].copy_from_slice(&(word | 0x20).to_le_bytes()[..width]);
    }
    bytes
}

fn assert_mov(bank: u8, instruction: crate::x86::instruction::Instruction) {
    assert_eq!(instruction.pc, PC);
    assert_eq!(instruction.next_pc, PC + 3);
    assert_eq!(
        instruction.operation,
        Operation::Mov {
            dst: RegisterView::low(bank),
            src: DataOperand::Register(RegisterView::low(bank)),
            width: Width::W16,
        }
    );
}

fn decode_and_check(expected: &[u8]) {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let bank = core.paging;
        let context = core.context.clone();
        let registers = unsafe { (*core.state.get()).registers };
        assert_mov(0, core.paged_decode(PC).unwrap());
        assert_eq!(
            core.image
                .physical_read_bytes(0, expected.len() as u32)
                .unwrap(),
            expected
        );
        assert_eq!(core.paging, bank);
        assert_eq!(core.context, context);
        unsafe {
            assert_eq!((*core.state.get()).registers, registers);
            assert_eq!((*core.state.get()).rip, PC);
            assert_eq!((*core.state.get()).flags, RF);
        }
    });
}

#[test]
fn warm_paged_decode_reads_one_hierarchy_per_unchanged_leaf_span() {
    for (family, counts) in [
        ("ia32e", [4, 32, 0, 0, 0, 0]),
        ("legacy32", [2, 8, 0, 0, 0, 0]),
        ("pae", [2, 16, 0, 0, 0, 0]),
        ("pg0", [0; 6]),
    ] {
        let expected = fixture(family, true, true);
        physical_counts::take();
        decode_and_check(&expected);
        assert_eq!(physical_counts::take(), counts, "{family}");
    }
}

#[test]
fn cold_paged_decode_keeps_accessed_writes_and_their_revalidation() {
    for (family, counts) in [
        ("ia32e", [30, 240, 4, 32, 4, 32]),
        ("legacy32", [13, 52, 2, 8, 2, 8]),
        ("pae", [13, 104, 2, 16, 2, 16]),
    ] {
        let expected = fixture(family, false, true);
        physical_counts::take();
        decode_and_check(&expected);
        assert_eq!(physical_counts::take(), counts, "{family}");
    }
}

#[test]
fn paged_decode_observes_a_warm_pte_remap_between_separate_calls() {
    fixture("ia32e", true, true);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        assert_mov(0, core.paged_decode(PC).unwrap());
        for (offset, byte) in [0x66, 0x89, 0xc9].into_iter().enumerate() {
            core.image
                .physical_write(0x8000 + offset as u64, 1, byte)
                .unwrap();
        }
        core.image.physical_write(0x4008, 8, 0x8027).unwrap();
        assert_mov(1, core.paged_decode(PC).unwrap());
        assert_eq!(core.paging.unwrap().cr2, 0xdead);
        assert_eq!(unsafe { (*core.state.get()).flags }, RF);
    });
}

#[test]
fn pg0_decode_keeps_actual_physical_execute_permission_checks() {
    fixture("pg0", true, false);
    physical_counts::take();
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        assert!(
            matches!(core.paged_decode(PC), Err(DecodeError::Paging(Failure::Physical(fault)))
            if fault.phase == PhysicalPhase::FinalAccess
                && fault.physical.address == PC
                && fault.physical.access == Access::Execute
                && fault.physical.cause == Cause::Permission)
        );
        assert_eq!(core.paging.unwrap().cr2, 0xdead);
        assert_eq!(unsafe { (*core.state.get()).flags }, RF);
    });
    assert_eq!(physical_counts::take(), [0; 6]);
}

#[test]
fn warm_decode_keeps_each_later_byte_physical_execute_admission() {
    use crate::memory::{MappingInput, MemoryLimits, Permissions};
    for mapped_tail in [false, true] {
        let bytes = fixture("ia32e", true, true);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            let mut mappings = vec![MappingInput {
                base: 0,
                backing: "ram".into(),
                offset: 0,
                length: 0x9001,
                permissions: Permissions {
                    read: true,
                    write: true,
                    execute: true,
                },
            }];
            if mapped_tail {
                mappings.push(MappingInput {
                    base: 0x9001,
                    backing: "ram".into(),
                    offset: 0x9001,
                    length: 0xfff,
                    permissions: Permissions {
                        read: true,
                        write: true,
                        execute: false,
                    },
                });
            }
            core.image = Image::physical_mapped(
                vec![("ram".into(), bytes)],
                mappings,
                MemoryLimits {
                    max_backing_bytes: 0xa000,
                    max_backings: 1,
                    max_mappings: 2,
                },
            )
            .unwrap();
            let bank = core.paging;
            let context = core.context.clone();
            let before = unsafe { (*core.state.get()).registers };
            let fault = match core.paged_decode(PC) {
                Err(DecodeError::Paging(Failure::Physical(fault))) => fault,
                other => panic!("expected later-byte physical refusal: {other:?}"),
            };
            assert_eq!(fault.linear, PC + 1);
            assert_eq!(fault.access, Access::Execute);
            assert_eq!(fault.phase, PhysicalPhase::FinalAccess);
            assert_eq!(fault.physical.address, 0x9001);
            assert_eq!(fault.physical.failing, 0x9001);
            assert_eq!(fault.physical.width, 1);
            assert_eq!(fault.physical.access, Access::Execute);
            assert_eq!(
                fault.physical.cause,
                if mapped_tail {
                    Cause::Permission
                } else {
                    Cause::Unmapped
                }
            );
            assert_eq!(core.paging, bank);
            assert_eq!(core.context, context);
            unsafe {
                assert_eq!((*core.state.get()).registers, before);
                assert_eq!((*core.state.get()).rip, PC);
                assert_eq!((*core.state.get()).flags, RF);
            }
        });
    }
}

#[test]
fn warm_decode_hits_remain_in_cold_cross_page_accessed_alias_revalidation() {
    use crate::memory::{MappingInput, MemoryLimits, Permissions};
    let mut bytes = fixture("ia32e", true, true);
    bytes.resize(0xb000, 0xa5);
    bytes[0x9ffc] = 0xb8; // MOV EAX, imm32 crosses onto the cold next page.
    bytes[0x9ffd..0xa005].copy_from_slice(&0xa007u64.to_le_bytes());
    let mappings = [
        (0, 0, 0x4010),
        (0x4010, 0x9ffd, 8), // PTE2.A aliases an already consumed immediate byte.
        (0x4018, 0x4018, 0xb000 - 0x4018),
    ]
    .into_iter()
    .map(|(base, offset, length)| MappingInput {
        base,
        backing: "ram".into(),
        offset,
        length,
        permissions: Permissions {
            read: true,
            write: true,
            execute: true,
        },
    })
    .collect();
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.image = Image::physical_mapped(
            vec![("ram".into(), bytes)],
            mappings,
            MemoryLimits {
                max_backing_bytes: 0xb000,
                max_backings: 1,
                max_mappings: 3,
            },
        )
        .unwrap();
        let bank = core.paging;
        let context = core.context.clone();
        let before = unsafe { (*core.state.get()).registers };
        assert!(matches!(
            core.paged_decode(0x1ffc),
            Err(DecodeError::PagingRestart)
        ));
        assert_eq!(core.image.physical_read(0x4010, 8).unwrap(), 0xa027);
        assert_eq!(core.image.physical_read(0x9ffd, 1).unwrap(), 0x27);
        let instruction = core.paged_decode(0x1ffc).unwrap();
        assert_eq!(instruction.pc, 0x1ffc);
        assert_eq!(instruction.next_pc, 0x2001);
        assert_eq!(
            instruction.operation,
            Operation::Mov {
                dst: RegisterView::low(0),
                src: DataOperand::Immediate(0xa027),
                width: Width::W32,
            }
        );
        assert_eq!(core.paging, bank);
        assert_eq!(core.context, context);
        unsafe {
            assert_eq!((*core.state.get()).registers, before);
            assert_eq!((*core.state.get()).rip, PC);
            assert_eq!((*core.state.get()).flags, RF);
        }
    });
}

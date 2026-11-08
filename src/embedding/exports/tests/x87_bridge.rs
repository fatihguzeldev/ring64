use super::*;
use crate::embedding::layout::X87_EXCEPTION;
use crate::memory::{MappingInput, MemoryLimits, Permissions};
use crate::x86::x87::{Format, Kind, Op, State as X87State};

fn operation(kind: Kind, format: Format, encoding: u16) -> Op {
    Op {
        kind,
        format,
        encoding,
        ..Op::default()
    }
}
fn invoke(operation: Op, offset: u64, pc: u64, flags: u64, rax: u64) -> i32 {
    x87::core_x87(
        operation.encode(),
        offset,
        Segment::Fs as u32,
        pc,
        flags,
        rax,
    )
}
fn install(state: X87State) {
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).x87 = state
    });
}
fn snapshot() -> X87State {
    BRIDGE.with_borrow(|bridge| unsafe { (*bridge.core.as_ref().unwrap().state.get()).x87 })
}

#[test]
fn x87_malformed_private_operations_reject_before_state_or_diagnostic_changes() {
    initialize(0x1000, &[0xf4]);
    let before = snapshot();
    assert_eq!(core_load(0x7000, 8), 0);
    let fault = metadata(DATA);
    for invalid in [31, 15 << 5, 1 << 31] {
        assert_eq!(
            x87::core_x87(invalid, 0, Segment::Ds as u32, 0x1000, 0x46, 0),
            -1
        );
        assert_eq!(snapshot(), before);
        assert_eq!(metadata(DATA), fault);
    }
    for invalid in [
        operation(Kind::Store, Format::None, 0),
        operation(Kind::LoadControl, Format::Register, 0),
        Op {
            index: 7,
            ..operation(Kind::Constant, Format::None, 0)
        },
        operation(Kind::Store, Format::F80, 0),
    ] {
        assert_eq!(
            x87::core_x87(invalid.encode(), 0, Segment::Ds as u32, 0x1000, 0x46, 0),
            -1
        );
        assert_eq!(snapshot(), before);
        assert_eq!(metadata(DATA), fault);
    }
    assert_eq!(
        x87::core_x87(
            operation(Kind::Wait, Format::None, 0).encode(),
            0,
            6,
            0x1000,
            0x46,
            0
        ),
        -1
    );
    assert_eq!(snapshot(), before);
    assert_eq!(metadata(DATA), fault);
}

#[test]
fn x87_pending_detector_precedes_operand_access_and_diagnostics_do_not_erase_pending() {
    initialize(0x1000, &[0xf4]);
    let mut pending = X87State {
        control_word: 0x37e,
        status_word: 0x8081,
        instruction_pointer: 0x1234,
        data_pointer: 0x5678,
        opcode: 0x52b,
        ..X87State::default()
    };
    for index in 0..8 {
        pending.set_raw(index, (0xff80u128 << 64) | index as u128);
    }
    install(pending);
    let load = operation(Kind::Load, Format::F80, 0x52b);
    for _ in 0..2 {
        assert_eq!(
            invoke(load, 0x800000000000, 0x2000, 0x8d7, 0x12345678),
            X87_EXCEPTION
        );
        assert_eq!(snapshot(), pending);
        assert!(BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().fault.is_none()));
        core_clear_fault();
    }
    // A no-wait status read still publishes AX from the live, unpublished RAX.
    assert_eq!(
        invoke(
            operation(Kind::StoreStatus, Format::Ax, 0x7e0),
            0,
            0x2001,
            0x46,
            0x123456789abcdef0
        ),
        0
    );
    assert_eq!(snapshot(), pending);
    BRIDGE.with_borrow(|bridge| unsafe {
        assert_eq!(
            (*bridge.core.as_ref().unwrap().state.get()).registers[0],
            0x123456789abc8081
        )
    });
    assert_eq!(
        invoke(operation(Kind::Wait, Format::None, 0), 0, 0x2003, 0x46, 0),
        X87_EXCEPTION
    );
    assert_eq!(snapshot(), pending);
}

#[test]
fn x87_failed_full_span_accesses_precede_stack_status_and_preserve_every_byte() {
    for failing in 0..10 {
        for store in [false, true] {
            initialize(0x1000, &[0xf4]);
            let mut before = X87State {
                instruction_pointer: 0x1111,
                data_pointer: 0x2222,
                opcode: 0x333,
                ..X87State::default()
            };
            if !store {
                before.tag_word = 0;
            }
            for index in 0..8 {
                before.set_raw(
                    index,
                    (0xffffu128 << 64) | 0x8000000000000000 | index as u128,
                );
            }
            install(before);
            let mut op = operation(
                if store { Kind::Store } else { Kind::Load },
                Format::F80,
                if store { 0x73b } else { 0x52b },
            );
            op.pop = u8::from(store);
            let address = 0x4010 - failing;
            assert_eq!(invoke(op, address, 0x1000, 0x8d7, 0), DATA);
            assert_eq!(snapshot(), before, "store={store}, failing={failing}");
            BRIDGE.with_borrow(|bridge| {
                let core = bridge.core.as_ref().unwrap();
                let fault = core.fault.as_ref().unwrap();
                assert_eq!(fault.address, address);
                assert_eq!(fault.width, 10);
                assert_eq!(fault.failing, 0x4010);
                assert_eq!(
                    fault.access,
                    if store { Access::Write } else { Access::Read }
                );
                assert_eq!(&core.image.read_vector(0x4000, 16).unwrap(), &[0xa5; 16]);
            });
        }
    }
}

#[test]
fn x87_exact_ten_byte_loads_keep_raw_encodings_and_update_only_defined_environment_fields() {
    let raw = (0x7fffu128 << 64) | 0x8000000000000011;
    for mode in [
        "long64",
        "protected",
        "compatibility",
        "real",
        "virtual8086",
    ] {
        initialize(0x1000, &[0xf4]);
        let context = if mode == "long64" {
            serde_json::json!({"mode":mode,"fsBase":"0x20000","gsBase":"0x0"})
        } else {
            let mut segments = serde_json::Map::new();
            for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
                segments.insert(name.into(), serde_json::json!({"base":if name=="cs"{"0x10000"}else if name=="fs"{"0x20000"}else{"0x0"},"limit":if mode=="virtual8086"{0xffffu32}else{0xffffffffu32},"default32":false,"usable":true,"type":if name=="cs"&&mode!="virtual8086"{"readable-code"}else{"read-write"}}));
            }
            serde_json::json!({"mode":mode,"segments":segments})
        };
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            core.context = ExecutionContext::from_json(&context).unwrap();
            core.image = Image::new(0x1000, vec![0xf4], 0x24000, vec![0xa5; 16]).unwrap();
            core.image
                .write_bytes(0x24006, &raw.to_le_bytes()[..10])
                .unwrap();
        });
        install(X87State {
            instruction_pointer: u64::MAX,
            data_pointer: u64::MAX,
            opcode: 0x123,
            ..X87State::default()
        });
        assert_eq!(
            invoke(
                operation(Kind::Load, Format::F80, 0x52b),
                0x4006,
                0x100001000,
                0x8d7,
                0
            ),
            0,
            "{mode}"
        );
        let after = snapshot();
        assert_eq!(after.raw(7), raw);
        assert_eq!(after.status_word, 0x3800);
        assert_eq!(after.tag_word, 0xbfff);
        assert_eq!(after.opcode, 0x123);
        assert_eq!(
            after.instruction_pointer,
            if mode == "long64" {
                0x100001000
            } else if matches!(mode, "real" | "virtual8086") {
                0x11000
            } else {
                0x1000
            }
        );
        assert_eq!(
            after.data_pointer,
            if matches!(mode, "real" | "virtual8086") {
                0x24006
            } else {
                0x4006
            }
        );
        assert_eq!(
            invoke(
                operation(Kind::Nop, Format::None, 0x1d0),
                0,
                0x100001002,
                0x8d7,
                0
            ),
            0
        );
        let nop = snapshot();
        assert_eq!(nop.instruction_pointer, after.instruction_pointer + 2);
        assert_eq!(nop.data_pointer, after.data_pointer);
        assert_eq!(nop.opcode, after.opcode);
        assert_eq!(nop.registers, after.registers);
    }
}

fn executable_alias(raw: u128) -> u64 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.image = Image::mapped(
            vec![("code".into(), raw.to_le_bytes()[..10].to_vec())],
            vec![
                MappingInput {
                    base: 0x1000,
                    backing: "code".into(),
                    offset: 0,
                    length: 10,
                    permissions: Permissions {
                        read: false,
                        write: false,
                        execute: true,
                    },
                },
                MappingInput {
                    base: 0x4000,
                    backing: "code".into(),
                    offset: 0,
                    length: 10,
                    permissions: Permissions {
                        read: false,
                        write: true,
                        execute: false,
                    },
                },
            ],
            MemoryLimits {
                max_backing_bytes: 10,
                max_backings: 1,
                max_mappings: 2,
            },
        )
        .unwrap();
        let owner = core.image.register_source([(0x1000, 10)]).unwrap();
        assert!(core.image.activate(owner));
        owner
    })
}

#[test]
fn x87_identity_code_store_invalidates_only_after_store_and_pop_commit() {
    initialize(0x1000, &[0xf4]);
    let raw = (0x3fffu128 << 64) | 0x8000000000000000;
    let owner = executable_alias(raw);
    let mut before = X87State {
        tag_word: 0xfffc,
        opcode: 0x123,
        ..X87State::default()
    };
    before.set_raw(0, raw);
    install(before);
    let mut store = operation(Kind::Store, Format::F80, 0x73b);
    store.pop = 1;
    assert_eq!(invoke(store, 0x4000, 0x1000, 0x8d7, 0), 2);
    let after = snapshot();
    assert_eq!(after.raw(0), raw);
    assert_eq!(after.tag_word, 0xffff);
    assert_eq!(after.status_word, 0x800);
    assert_eq!(after.instruction_pointer, 0x1000);
    assert_eq!(after.data_pointer, 0x4000);
    assert_eq!(after.opcode, 0x123);
    assert!(!BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().image.owner_valid(owner)));

    let owner = executable_alias(raw);
    let mut before = X87State {
        control_word: 0x377,
        tag_word: 0xfffc,
        ..X87State::default()
    };
    before.set_raw(0, (0x407fu128 << 64) | 0x8000000000000000);
    install(before);
    store.format = Format::F32;
    store.encoding = 0x11b;
    assert_eq!(invoke(store, 0x4000, 0x1000, 0x8d7, 0), 0);
    let after = snapshot();
    assert_eq!(after.raw(0), before.raw(0));
    assert_eq!(after.tag_word, before.tag_word);
    assert_eq!(after.status_word, 0x8088);
    assert_eq!(after.opcode, 0x11b);
    assert!(BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().image.owner_valid(owner)));
}

use super::*;
use crate::memory::{MappingInput, MemoryLimits, Permissions};
use crate::x86::compound_stack::{CompoundStack, CompoundStackKind};
use crate::x86::instruction::Width;

#[test]
fn compound_payload_cancels_source_owners_at_saturated_epochs_even_after_a_late_fault() {
    for epoch in [0, u64::MAX - 1, u64::MAX] {
        for failed_probe in [false, true] {
            let code = [
                0xc8,
                0,
                if failed_probe { 0x10 } else { 0 },
                0,
                0xb8,
                1,
                0,
                0,
                0,
                0x82,
                0x90,
                0x90,
                0x90,
                0x90,
                0x90,
                0x90,
            ];
            initialize(0x1000, &code);
            BRIDGE.with_borrow_mut(|bridge| {
                let core = bridge.core.as_mut().unwrap();
                core.context_version = epoch;
                core.image = Image::mapped(
                    vec![("code".into(), code.to_vec())],
                    vec![
                        MappingInput {
                            base: 0x1000,
                            backing: "code".into(),
                            offset: 0,
                            length: 16,
                            permissions: Permissions {
                                read: true,
                                write: false,
                                execute: true,
                            },
                        },
                        MappingInput {
                            base: 0x4ff8,
                            backing: "code".into(),
                            offset: 4,
                            length: 8,
                            permissions: Permissions {
                                read: true,
                                write: true,
                                execute: false,
                            },
                        },
                    ],
                    MemoryLimits {
                        max_backing_bytes: 16,
                        max_backings: 1,
                        max_mappings: 2,
                    },
                )
                .unwrap();
                unsafe {
                    let state = &mut *core.state.get();
                    state.registers[4] = 0x5000;
                    state.registers[5] = 0x90908200000009b8;
                    state.flags = 2;
                }
            });
            let compile = || {
                assert_eq!(core_compile(0x1004, 8, 128, 65536), 0);
                BRIDGE.with_borrow(|bridge| {
                    let info: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
                    u64::from_str_radix(
                        info["owner"].as_str().unwrap().trim_start_matches("0x"),
                        16,
                    )
                    .unwrap()
                })
            };
            let installed = compile();
            assert_eq!(mapped::core_publish(installed), 1);
            let pending = compile();
            assert_eq!(mapped::core_activate(installed), 1);
            let status = super::super::compound_stack::core_compound_stack(
                CompoundStack {
                    kind: CompoundStackKind::Enter {
                        allocation: if failed_probe { 0x1000 } else { 0 },
                        nesting: 0,
                    },
                    width: Width::W64,
                }
                .encode(),
            );
            assert_eq!(status, if failed_probe { DATA } else { 2 });
            assert_eq!(
                mapped::core_publish(pending),
                0,
                "payload invalidates pending source regardless of epoch"
            );
            assert_eq!(
                mapped::core_activate(installed),
                0,
                "payload invalidates active source even at retired0"
            );
            BRIDGE.with_borrow(|bridge| {
                let core = bridge.core.as_ref().unwrap();
                assert_eq!(core.context_version, epoch);
                assert_eq!(core.image.read(0x1004, 8), Ok(0x90908200000009b8));
                let state = unsafe { &*core.state.get() };
                assert_eq!(
                    state.registers[4],
                    if failed_probe { 0x5000 } else { 0x4ff8 }
                );
                assert_eq!(
                    state.registers[5],
                    if failed_probe {
                        0x90908200000009b8
                    } else {
                        0x4ff8
                    }
                );
            });
            let fresh = compile();
            assert!(fresh > pending);
            assert_eq!(mapped::core_publish(fresh), 1);
            assert_eq!(mapped::core_activate(fresh), 1);
        }
    }
}

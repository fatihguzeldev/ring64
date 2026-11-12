use super::*;
use crate::embedding::layout::{DEVICE_NOT_AVAILABLE, SIMD_EXCEPTION, X87_EXCEPTION};
use crate::x86::float::{Format as FloatFormat, Kind as FloatKind, Op as FloatOp};
use crate::x86::numeric_controls::{Family, Fault as NumericFault};

const PC: u64 = 0x400000;
const RF: u64 = 0x10002;

fn paged(code: &[u8]) {
    let mut bytes = vec![0; 0xa000];
    for (offset, word) in [
        (0x1000, 0x2027u64),
        (0x2000, 0x3027),
        (0x3010, 0x4027),
        (0x4000, 0x9067),
    ] {
        bytes[offset..offset + 8].copy_from_slice(&word.to_le_bytes());
    }
    bytes[0x9000..0x9000 + code.len()].copy_from_slice(code);
    let config = serde_json::json!({
        "memoryModel":"ia32e-paged", "paging":{"cr0":"0x80000033","cr2":"0xdead","cr3":"0x1000","cr4":"0x628","efer":"0x500"},
        "memoryLimits":{"maxBackingBytes":40960,"maxBackings":1,"maxMappings":1},
        "backings":[{"id":"ram","length":40960}],
        "mappings":[{"base":"0x0","backing":"ram","offset":0,"length":40960,"permissions":{"read":true,"write":true,"execute":true}}]
    });
    let length = mapped_input(config, &bytes);
    assert_eq!(mapped::core_init_mapped(PC, length), 0);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).flags = RF;
    });
}

fn boundary(reached: bool, pc: u64) -> i32 {
    if reached {
        paging::core_paged_debug_begin(pc, RF, 0)
    } else {
        core_probe(pc)
    }
}

#[test]
fn fixed_private_admission_keeps_debug_legality_and_pending_mf_at_their_original_boundaries() {
    for (code, expected, waiting) in [
        (&[0x90][..], 0, false),
        (&[0x0f, 0x21, 0xe0][..], INVALID, false), // MOV rax,DR4
        (&[0xd9, 0xd0][..], 0, true),              // FNOP
    ] {
        initialize(0x1000, code);
        BRIDGE.with_borrow_mut(|bridge| unsafe {
            let state = &mut *bridge.core.as_mut().unwrap().state.get();
            state.flags = RF;
            state.x87.control_word = 0x37e;
            state.x87.status_word = 0x8081;
        });
        assert_eq!(core_probe(0x1000), expected);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            assert_eq!(core.numeric_fault, None);
            assert_eq!(unsafe { (*core.state.get()).flags }, RF);
        });
        if waiting {
            assert_eq!(
                x87::core_x87(
                    crate::x86::x87::Op {
                        kind: crate::x86::x87::Kind::Nop,
                        ..Default::default()
                    }
                    .encode(),
                    0,
                    Segment::Ds as u32,
                    0x1000,
                    RF,
                    0,
                ),
                X87_EXCEPTION
            );
        }
    }
}

#[test]
fn actual_admission_boundaries_clear_prior_numeric_sources_before_default_scalar_and_fetch_faults()
{
    for reached in [false, true] {
        paged(&[0x90]);
        for pc in [PC, PC + 0x1000] {
            BRIDGE.with_borrow_mut(|bridge| {
                let core = bridge.core.as_mut().unwrap();
                core.numeric_fault = Some(NumericFault {
                    kind: 1,
                    family: Family::X87,
                    controls: 29,
                    instruction_pc: PC - 2,
                    stage: 0,
                    raised: 0,
                    before: 0,
                    after: 0,
                });
                core.numeric_form = Some((Family::Simd, PC - 4));
            });
            assert_eq!(boundary(reached, pc), if pc == PC { 0 } else { 24 });
            BRIDGE.with_borrow(|bridge| {
                let core = bridge.core.as_ref().unwrap();
                assert_eq!(core.numeric_fault, None);
                assert_eq!(core.numeric_form, None);
                let state = unsafe { &*core.state.get() };
                assert_eq!((state.rip, state.flags), (PC, RF));
            });
        }
    }
}

#[test]
fn enabled_admission_preserves_default_mf_and_live_control_repair_on_the_same_owner() {
    for reached in [false, true] {
        for cr0 in [0x80000031, 0x80000033] {
            paged(&[0xd9, 0xd0]); // FNOP
            assert_eq!(core_compile(PC, 1, 15, 65536), 0);
            let owner = BRIDGE.with_borrow(|bridge| {
                let info: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
                u64::from_str_radix(info["owner"].as_str().unwrap().trim_start_matches("0x"), 16)
                    .unwrap()
            });
            assert_eq!(mapped::core_publish(owner), 1);
            for disabled in [cr0 | 4, cr0 | 8] {
                assert_eq!(paging::core_paging_control(1, 0, disabled, PC, RF), 0);
                assert_eq!(boundary(reached, PC), DEVICE_NOT_AVAILABLE);
                BRIDGE.with_borrow(|bridge| {
                    let fault = bridge.core.as_ref().unwrap().numeric_fault.unwrap();
                    assert_eq!((fault.vector(), fault.instruction_pc), (7, PC));
                });
                assert_eq!(paging::core_paging_control(1, 0, cr0, PC, RF), 0);
                assert_eq!(mapped::core_validity(owner), 1);
                assert_eq!(mapped::core_activate(owner), 1);
                assert_eq!(boundary(reached, PC), 0);
                BRIDGE.with_borrow_mut(|bridge| unsafe {
                    let core = bridge.core.as_mut().unwrap();
                    assert_eq!(core.numeric_fault, None);
                    assert_eq!((*core.state.get()).flags, RF);
                    (*core.state.get()).x87.control_word = 0x37e;
                    (*core.state.get()).x87.status_word = 0x8081;
                });
                assert_eq!(
                    boundary(reached, PC),
                    0,
                    "ordinary #MF belongs to the helper"
                );
                assert_eq!(
                    x87::core_paged_x87(
                        crate::x86::x87::Op {
                            kind: crate::x86::x87::Kind::Nop,
                            ..Default::default()
                        }
                        .encode(),
                        0,
                        Segment::Ds as u32,
                        PC,
                        RF,
                        0,
                    ),
                    X87_EXCEPTION
                );
            }
        }
    }
}

#[test]
fn simd_numeric_ud_uses_reached_pc_then_default_repair_returns_to_xm_without_stale_source() {
    for reached in [false, true] {
        paged(&[0x90, 0xf2, 0x0f, 0x5e, 0xc1]); // NOP; DIVSD xmm0,xmm1
        assert_eq!(paging::core_paging_control(1, 4, 0x228, PC, RF), 0);
        let divide = FloatOp {
            kind: FloatKind::Div,
            format: FloatFormat::F64,
            scalar: true,
            integer64: false,
            predicate: 0,
        }
        .encode();
        BRIDGE.with_borrow_mut(|bridge| unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).mxcsr = 0x1d80;
        });
        assert_eq!(boundary(reached, PC + 1), 0);
        assert_eq!(
            numeric::core_float(divide, 0x3ff0000000000000, 0, 0, 0),
            INVALID
        );
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            let fault = core.numeric_fault.unwrap();
            assert_eq!((fault.kind, fault.instruction_pc), (4, PC + 1));
            assert_eq!(
                (fault.raised, fault.before, fault.after),
                (4, 0x1d80, 0x1d84)
            );
            assert!(core.simd_exception.is_none());
        });
        assert_eq!(paging::core_paging_control(1, 4, 0x628, PC, RF), 0);
        assert_eq!(boundary(reached, PC + 1), 0);
        assert_eq!(
            numeric::core_float(divide, 0x3ff0000000000000, 0, 0, 0),
            SIMD_EXCEPTION
        );
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            assert_eq!(core.numeric_fault, None);
            let exception = core.simd_exception.as_ref().unwrap();
            assert_eq!((exception.raised, exception.after), (4, 0x1d84));
        });
    }
}

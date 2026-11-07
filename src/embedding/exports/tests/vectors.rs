use super::*;
use crate::embedding::layout::ALIGNMENT;

fn scratch(bytes: [u8; 16]) -> u32 {
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        let state = &mut *bridge.core.as_mut().unwrap().state.get();
        state.vector_scratch = bytes;
        state.vector_scratch.as_ptr() as u32
    })
}

#[test]
fn wide_loads_preserve_zero_upper_bits_and_order_alignment_before_mapping() {
    initialize(0x1000, &[0xf4]);
    assert_ne!(
        vector::core_vector_load(0x4000, 16, Segment::Ds as u32, 16),
        0
    );
    BRIDGE.with_borrow(|bridge| unsafe {
        assert_eq!(
            (*bridge.core.as_ref().unwrap().state.get()).vector_scratch,
            [0xa5; 16]
        );
    });
    assert_ne!(
        vector::core_vector_load(0x4000, 2, Segment::Ds as u32, 1),
        0
    );
    BRIDGE.with_borrow(|bridge| unsafe {
        let mut expected = [0; 16];
        expected[..2].fill(0xa5);
        assert_eq!(
            (*bridge.core.as_ref().unwrap().state.get()).vector_scratch,
            expected
        );
    });
    assert_eq!(
        vector::core_vector_load(0x7001, 16, Segment::Fs as u32, 16),
        0
    );
    assert_eq!(context::core_access_reason(), ALIGNMENT);
    assert_eq!(
        metadata(ALIGNMENT),
        serde_json::json!({"segment":"fs","offset":"0x7001","address":"0x7001","width":16,"access":"read","alignment":16})
    );
    assert_eq!(metadata(DATA), serde_json::Value::Null);
    assert_eq!(
        vector::core_vector_load(0x800000000001, 16, Segment::Ds as u32, 16),
        0
    );
    assert_eq!(context::core_access_reason(), DATA);
    assert_eq!(metadata(DATA)["cause"], "noncanonical");
    assert_eq!(metadata(ALIGNMENT), serde_json::Value::Null);
}

#[test]
fn xmm_import_is_complete_little_endian_and_scalar_import_preserves_it() {
    initialize(0x1000, &[0xf4]);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = (0..=255).collect());
    assert_eq!(vector::core_import_xmm(), 0);
    BRIDGE.with_borrow(|bridge| unsafe {
        let state = &*bridge.core.as_ref().unwrap().state.get();
        assert_eq!(state.xmm[0], std::array::from_fn(|i| i as u8));
        assert_eq!(state.xmm[15], std::array::from_fn(|i| 240 + i as u8));
    });
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input = vec![0; SCALAR_STATE_SIZE];
        bridge.input[128] = 2;
    });
    assert_eq!(core_import_state(), 0);
    BRIDGE.with_borrow(|bridge| unsafe {
        assert_eq!(
            (*bridge.core.as_ref().unwrap().state.get()).xmm[15][15],
            255
        );
    });
    let data = serde_json::json!({"base":"0x0","limit":u32::MAX,"default32":true,"usable":true,"type":"read-write"});
    let mut protected = serde_json::json!({"mode":"protected","segments":{"cs":data,"ss":data,"ds":data,"es":data,"fs":data,"gs":data}});
    protected["segments"]["cs"]["type"] = serde_json::json!("readable-code");
    for context in [
        protected,
        serde_json::json!({"mode":"long64","fsBase":"0x0","gsBase":"0x0"}),
    ] {
        BRIDGE.with_borrow_mut(|bridge| bridge.input = serde_json::to_vec(&context).unwrap());
        assert_eq!(context::core_set_context(), 0);
        BRIDGE.with_borrow(|bridge| unsafe {
            assert_eq!(
                (*bridge.core.as_ref().unwrap().state.get()).xmm,
                std::array::from_fn(|register| std::array::from_fn(
                    |byte| (register * 16 + byte) as u8
                ))
            );
        });
    }
    BRIDGE.with_borrow_mut(|bridge| bridge.input = vec![0; 255]);
    assert_eq!(vector::core_import_xmm(), 1);
    BRIDGE.with_borrow(|bridge| unsafe {
        assert_eq!(
            (*bridge.core.as_ref().unwrap().state.get()).xmm[15][15],
            255
        );
    });
}

#[test]
fn wide_store_checks_every_byte_before_writing_and_aggregates_source_invalidation() {
    initialize(0x1000, &[0xf4]);
    let pointer = scratch([0x77; 16]);
    assert_eq!(
        vector::core_vector_store(0x4008, 16, Segment::Ds as u32, 1, pointer),
        0
    );
    assert_eq!(core_load(0x4000, 8), 0xa5a5a5a5a5a5a5a5);
    assert_eq!(core_load(0x4008, 8), 0xa5a5a5a5a5a5a5a5);
    assert_eq!(
        vector::core_vector_store(0x4000, 16, Segment::Ds as u32, 16, pointer),
        1
    );
    assert_eq!(core_load(0x4000, 8), 0x7777777777777777);
    assert_eq!(core_load(0x4008, 8), 0x7777777777777777);
    BRIDGE.with_borrow_mut(|bridge| {
        let image = &mut bridge.core.as_mut().unwrap().image;
        image
            .set_mappings(vec![
                crate::memory::MappingInput {
                    base: 0x4000,
                    backing: "ram".into(),
                    offset: 0,
                    length: 8,
                    permissions: crate::memory::Permissions {
                        read: true,
                        write: true,
                        execute: true,
                    },
                },
                crate::memory::MappingInput {
                    base: 0x4008,
                    backing: "ram".into(),
                    offset: 8,
                    length: 8,
                    permissions: crate::memory::Permissions {
                        read: true,
                        write: true,
                        execute: false,
                    },
                },
            ])
            .unwrap();
        let owner = image.register_source([(0x4000, 1)]).unwrap();
        assert!(image.activate(owner));
    });
    assert_eq!(
        vector::core_vector_store(0x4000, 16, Segment::Ds as u32, 16, pointer),
        2
    );
    assert_eq!(
        vector::core_vector_load(0x7001, 16, Segment::Ds as u32, 16),
        0
    );
    core_clear_fault();
    assert_eq!(metadata(ALIGNMENT), serde_json::Value::Null);
}

#[test]
fn xmm_import_clears_only_successful_diagnostics_and_preserves_live_execution_ownership() {
    initialize(0x1000, &[0xb8, 1, 0, 0, 0]);
    assert_eq!(core_compile(0x1000, 8, 128, 65536), DISPATCH);
    assert_eq!(
        vector::core_vector_load(0x7001, 16, Segment::Fs as u32, 16),
        0
    );
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.divide_failed = true;
        let state = unsafe { &mut *core.state.get() };
        state.registers = [0x0123456789abcdef; 16];
        state.flags = 0xcd7;
        state.rip = 0x1000;
        state.remaining = 19;
        state.repeat_remaining = 7;
        state.target = 0x800000000000;
        bridge.input = vec![0xaa; 255];
    });
    assert_eq!(vector::core_import_xmm(), 1);
    assert_eq!(context::core_access_reason(), ALIGNMENT);
    assert_eq!(core_divide_failed(), 1);
    assert_eq!(metadata(TARGET)["address"], "0x800000000000");
    BRIDGE.with_borrow_mut(|bridge| bridge.input = vec![0xaa; 256]);
    assert_eq!(vector::core_import_xmm(), 0);
    assert_eq!(metadata(ALIGNMENT), serde_json::Value::Null);
    assert_eq!(metadata(DATA), serde_json::Value::Null);
    assert_eq!(metadata(SEGMENT), serde_json::Value::Null);
    assert_eq!(core_divide_failed(), 0);
    assert_eq!(mapped::core_validity(1), 1);
    assert_eq!(context::core_context_version(), 0);
    assert_eq!(core_load(0x4000, 8), 0xa5a5a5a5a5a5a5a5);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(state.registers, [0x0123456789abcdef; 16]);
        assert_eq!(
            (
                state.flags,
                state.rip,
                state.remaining,
                state.repeat_remaining,
                state.target
            ),
            (0xcd7, 0x1000, 19, 7, 0)
        );
        assert_eq!(state.xmm, [[0xaa; 16]; 16]);
    });
}

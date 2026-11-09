use super::*;

fn scalar_input(flags: u64, shadow: u32) {
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input = vec![0; SCALAR_STATE_SIZE];
        bridge.input[128..136].copy_from_slice(&flags.to_le_bytes());
        bridge.input[136..144].copy_from_slice(&0x1000_u64.to_le_bytes());
        bridge.input[164..168].copy_from_slice(&shadow.to_le_bytes());
    });
}

#[test]
fn scalar_import_rejects_inconsistent_interruptibility_before_publication() {
    initialize(0x1000, &[0x90]);
    for (flags, shadow) in [(2, 3), (2, 1), (0x202, 4), (0x20002, 0)] {
        scalar_input(flags, shadow);
        assert_eq!(core_import_state(), 1, "{flags:x}/{shadow}");
        BRIDGE.with_borrow(|bridge| {
            let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
            assert_eq!(state.flags, 2);
            assert_eq!(state.rip, 0x1000);
        });
    }
}

#[test]
fn imported_boundary_history_and_context_replacement_have_explicit_lifetimes() {
    initialize(0x1000, &[0x90]);
    scalar_input(0x202, 1);
    assert_eq!(core_import_state(), 0);
    BRIDGE.with_borrow(|bridge| {
        assert_eq!(
            unsafe { (*bridge.core.as_ref().unwrap().state.get()).interruptibility },
            1
        );
    });
    core_clear_fault();
    assert_eq!(core_probe(0x1000), 0);
    BRIDGE.with_borrow_mut(|bridge| {
        assert_eq!(
            unsafe { (*bridge.core.as_ref().unwrap().state.get()).interruptibility },
            1
        );
        bridge.input = b"{}".to_vec();
    });
    assert_eq!(context::core_set_context(), 1);
    BRIDGE.with_borrow_mut(|bridge| {
        assert_eq!(
            unsafe { (*bridge.core.as_ref().unwrap().state.get()).interruptibility },
            1
        );
        bridge.input =
            serde_json::to_vec(&bridge.core.as_ref().unwrap().context.to_json()).unwrap();
    });
    assert_eq!(context::core_set_context(), 0);
    BRIDGE.with_borrow(|bridge| {
        assert_eq!(
            unsafe { (*bridge.core.as_ref().unwrap().state.get()).interruptibility },
            0
        );
    });
}

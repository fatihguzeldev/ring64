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

#[test]
fn boundary_profiles_guard_activation_without_invalidating_source_owners() {
    initialize(0x1000, &[0x90]);
    let compile = || {
        assert_eq!(core_compile(0x1000, 1, 16, 65536), 0);
        BRIDGE.with_borrow(|bridge| {
            let value: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
            (
                u64::from_str_radix(
                    value["owner"].as_str().unwrap().trim_start_matches("0x"),
                    16,
                )
                .unwrap(),
                value["boundaryObserved"].as_bool().unwrap(),
            )
        })
    };
    let (fast, observed) = compile();
    assert!(!observed);
    scalar_input(0x102, 0);
    assert_eq!(core_import_state(), 0);
    assert_eq!(mapped::core_validity(fast), 1);
    assert_eq!(mapped::core_activate(fast), 0);
    let (step, observed) = compile();
    assert!(observed);
    assert_eq!(mapped::core_activate(step), 1);
    scalar_input(2, 0);
    assert_eq!(core_import_state(), 0);
    assert_eq!(mapped::core_validity(step), 1);
    assert_eq!(mapped::core_activate(step), 0);
    assert_eq!(mapped::core_activate(fast), 1);
    mapped::core_release(step);
    BRIDGE.with_borrow(|bridge| {
        assert!(
            !bridge
                .core
                .as_ref()
                .unwrap()
                .observed_owners
                .contains(&step)
        )
    });
}

use super::*;

#[test]
fn reset_projection_is_not_finit_and_keeps_image_owner_ids_at_epoch_saturation() {
    for epoch in [0, u64::MAX] {
        initialize(0x1000, &[0x90]);
        let compile = || {
            assert_eq!(core_compile(0x1000, 1, 15, 65536), 0);
            BRIDGE.with_borrow(|b| {
                let info: serde_json::Value = serde_json::from_slice(&b.info).unwrap();
                u64::from_str_radix(info["owner"].as_str().unwrap().trim_start_matches("0x"), 16)
                    .unwrap()
            })
        };
        let owner = compile();
        assert_eq!(mapped::core_publish(owner), 1);
        let pending = compile();
        BRIDGE.with_borrow_mut(|b| {
            let c = b.core.as_mut().unwrap();
            c.physical_controls = true;
            c.context_version = epoch;
            c.io_present = true;
            c.io_configured = true;
            c.io_effect = true;
            unsafe {
                (*c.state.get()).registers = [u64::MAX; 16];
                (*c.state.get()).xmm = [[0xa5; 16]; 16];
                (*c.state.get()).interrupts.nmi_blocked = 1;
            }
        });
        assert_eq!(super::super::reset::core_reset(), 0);
        assert_eq!(mapped::core_validity(owner), 0);
        assert_eq!(mapped::core_publish(pending), 0);
        BRIDGE.with_borrow_mut(|b| {
            let c = b.core.as_mut().unwrap();
            let s = unsafe { &*c.state.get() };
            let mut registers = [0; 16];
            registers[2] = 0x600;
            assert_eq!(s.registers, registers);
            assert_eq!(s.rip, 0xfff0);
            assert_eq!(s.flags, 2);
            assert_eq!(s.x87.control_word, 0x40);
            assert_eq!(s.x87.status_word, 0);
            assert_eq!(s.x87.tag_word, 0x5555);
            assert_eq!(s.x87.registers, [[0; 10]; 8]);
            assert_eq!(s.xmm, [[0; 16]; 16]);
            assert_eq!(s.mxcsr, 0x1f80);
            assert_eq!(s.event, RawEventState::default());
            assert_eq!(s.interrupts, RawInterruptState::default());
            assert_eq!(c.paging, Some(crate::x86::paging::State::reset()));
            assert_eq!(c.context, ExecutionContext::reset());
            assert!(c.io_present && c.io_configured && !c.io_effect);
            assert_eq!(c.image.read(0x1000, 1), Ok(0x90));
            // Return only test context to the original executable map; reset itself
            // must not replace Image or reset its identity allocator.
            c.context = ExecutionContext::default();
            c.paging = None;
        });
        let fresh = compile();
        assert!(fresh > pending && pending > owner);
        assert_eq!(mapped::core_publish(fresh), 1);
        mapped::core_release(owner);
        mapped::core_release(pending);
        assert_eq!(mapped::core_activate(fresh), 1);
    }
}

#[test]
fn old_private_models_reject_reset_without_mutating_any_bank() {
    initialize(0x1000, &[0x90]);
    assert_eq!(super::super::reset::core_reset(), 1);
    BRIDGE.with_borrow(|b| {
        let c = b.core.as_ref().unwrap();
        assert_eq!(unsafe { (*c.state.get()).rip }, 0x1000);
        assert!(c.paging.is_none());
    });
}

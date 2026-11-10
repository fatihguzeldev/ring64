use super::*;

#[test]
fn fixed_profile_normalizes_reserved_fields_without_rejecting_raw_address_bits() {
    assert_eq!(
        (State::default().dr6, State::default().dr7),
        (0xffff0ff0, 0x400)
    );
    let mut s = State {
        addresses: [0x800000000000, u64::MAX, 3, 4],
        dr6: 0xffffffff,
        dr7: 0xffffffff,
    };
    s.normalize();
    assert_eq!(s.addresses, [0x800000000000, u64::MAX, 3, 4]);
    assert_eq!((s.dr6, s.dr7), (0xffffefff, 0xffff27ff));
}

#[test]
fn comparison_is_linear_directional_and_only_for_enabled_valid_ranges() {
    let mut s = State {
        addresses: [0x6000, 0x6004, 0x7000, 0x800000000000],
        dr7: 0x33_9_0_0455,
        ..State::default()
    };
    // Slot0 execute, slot1 write8, slot2 read/write4, slot3 invalid execute configuration.
    s.dr7 = 0x55 | (9 << 20) | (15 << 24) | (4 << 28);
    assert_eq!(s.matches(0x6000, 1, Access::Execute), 1);
    assert_eq!(s.matches(0x6001, 1, Access::Execute), 0);
    assert_eq!(s.matches(0x6000, 8, Access::Read), 0);
    s.addresses[1] = 0x6008;
    assert_eq!(s.matches(0x6007, 2, Access::Write), 2);
    assert_eq!(s.matches(0x6007, 2, Access::Read), 0);
    assert_eq!(s.matches(0x6fff, 2, Access::Read), 4);
    assert_eq!(s.matches(0x7003, 2, Access::Write), 4);
    assert_eq!(s.matches(0x7004, 1, Access::Write), 0);
    assert_eq!(s.matches(0x800000000000, 1, Access::Execute), 0);
    s.dr7 &= !0xff;
    assert_eq!(s.matches(0x7000, 4, Access::Read), 0);
}

#[test]
fn fresh_slots_replace_but_status_causes_latch_and_historical_hits_do_not_recheck_enables() {
    let mut s = State::default();
    s.select(3, true, false);
    assert_eq!(s.dr6, 0xffff4ff3);
    s.select(0, false, true);
    assert_eq!(s.dr6, 0xffff6ff0);
    s.select(8, false, false);
    assert_eq!(s.dr6, 0xffff6ff8);
}

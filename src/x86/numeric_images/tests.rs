use super::*;

mod fx;
mod legacy;

fn state() -> X87State {
    let mut state = X87State {
        control_word: 0x37b,
        status_word: 0xa884,
        tag_word: 0xfffc,
        opcode: 0x123,
        instruction_pointer: 0x1234_5678_fedc_ba98,
        data_pointer: 0x8877_6655_1122_3344,
        ..X87State::default()
    };
    for index in 1..8 {
        state.set_raw(
            index,
            ((0x4000 + index as u128) << 64) | (1 << 63) | index as u128,
        );
    }
    state
}

fn xmm() -> [[u8; 16]; 16] {
    std::array::from_fn(|bank| std::array::from_fn(|byte| (bank * 16 + byte) as u8))
}

fn bytes(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn image_descriptors_reject_unselected_kind_layout_pairs_and_unused_bits() {
    let mut admitted = 0;
    for encoded in 0..256 {
        if let Some(operation) = ImageOp::try_decode(encoded) {
            admitted += 1;
            assert_eq!(operation.encode(), encoded);
            assert_eq!(
                operation.is_waiting(),
                matches!(operation.kind, Kind::LoadEnvironment | Kind::Restore)
            );
        }
    }
    assert_eq!(admitted, 22);
    for value in [u32::MAX, 1 << 16, 1 << 31] {
        assert!(ImageOp::try_decode(value).is_none());
    }
}

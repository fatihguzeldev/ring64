use super::*;
use crate::x86::x87::classify_tag;

pub(super) fn save(
    operation: ImageOp,
    state: &X87State,
    xmm: &[[u8; 16]; 16],
    mxcsr: u32,
) -> [u8; 512] {
    let mut bytes = [0; 512];
    put_word(&mut bytes, 0, state.control_word);
    put_word(&mut bytes, 2, state.status_word);
    for physical in 0..8 {
        if state.tag(physical) != 3 {
            bytes[4] |= 1 << physical;
        }
    }
    put_word(&mut bytes, 6, state.opcode & 0x7ff);
    if operation.format == Format::Fx64Wide {
        bytes[8..16].copy_from_slice(&state.instruction_pointer.to_le_bytes());
        bytes[16..24].copy_from_slice(&state.data_pointer.to_le_bytes());
    } else {
        put_dword(&mut bytes, 8, state.instruction_pointer as u32);
        put_dword(&mut bytes, 16, state.data_pointer as u32);
    }
    put_dword(&mut bytes, 24, mxcsr);
    put_dword(&mut bytes, 28, 0xffff);
    for logical in 0..8 {
        bytes[32 + logical * 16..42 + logical * 16]
            .copy_from_slice(&state.registers[(state.top() + logical) & 7]);
    }
    for (bank, value) in xmm.iter().enumerate().take(operation.xmm_count()) {
        bytes[160 + bank * 16..176 + bank * 16].copy_from_slice(value);
    }
    bytes
}

pub(super) fn restore(operation: ImageOp, bytes: &[u8; 512], result: &mut Restored) {
    let state = &mut result.x87;
    state.control_word = word(bytes, 0);
    state.status_word = word(bytes, 2);
    state.opcode = word(bytes, 6) & 0x7ff;
    if operation.format == Format::Fx64Wide {
        state.instruction_pointer = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        state.data_pointer = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
    } else {
        state.instruction_pointer = u64::from(dword(bytes, 8));
        state.data_pointer = u64::from(dword(bytes, 16));
    }
    for logical in 0..8 {
        state.registers[(state.top() + logical) & 7]
            .copy_from_slice(&bytes[32 + logical * 16..42 + logical * 16]);
    }
    for physical in 0..8 {
        let tag = if bytes[4] & (1 << physical) == 0 {
            3
        } else {
            classify_tag(state.raw(physical))
        };
        state.set_tag(physical, tag);
    }
    state.refresh();
    for (bank, target) in result
        .xmm
        .iter_mut()
        .enumerate()
        .take(operation.xmm_count())
    {
        target.copy_from_slice(&bytes[160 + bank * 16..176 + bank * 16]);
    }
}

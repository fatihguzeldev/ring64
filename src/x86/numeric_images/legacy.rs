use super::*;
use crate::x86::x87::classify_tag;

pub(super) fn save(operation: ImageOp, state: &X87State) -> [u8; 512] {
    let mut bytes = [0; 512];
    let short = operation.format.environment_bytes() == 14;
    put_word(&mut bytes, 0, state.control_word);
    put_word(&mut bytes, if short { 2 } else { 4 }, state.status_word);
    let mut tag_word = 0;
    for index in 0..8 {
        let tag = if state.tag(index) == 3 {
            3
        } else {
            classify_tag(state.raw(index))
        };
        tag_word |= tag << (2 * index);
    }
    put_word(&mut bytes, if short { 4 } else { 8 }, tag_word);
    let ip = state.instruction_pointer;
    let dp = state.data_pointer;
    match operation.format {
        Format::Protected16 => {
            put_word(&mut bytes, 6, ip as u16);
            put_word(&mut bytes, 10, dp as u16);
        }
        Format::Protected32 => {
            put_dword(&mut bytes, 12, ip as u32);
            put_word(&mut bytes, 18, state.opcode & 0x7ff);
            put_dword(&mut bytes, 20, dp as u32);
        }
        Format::Real16 => {
            put_word(&mut bytes, 6, ip as u16);
            put_word(
                &mut bytes,
                8,
                (((ip >> 16) & 0xf) << 12) as u16 | state.opcode & 0x7ff,
            );
            put_word(&mut bytes, 10, dp as u16);
            put_word(&mut bytes, 12, (((dp >> 16) & 0xf) << 12) as u16);
        }
        Format::Real32 => {
            put_word(&mut bytes, 12, ip as u16);
            put_dword(
                &mut bytes,
                16,
                (((ip >> 16) & 0xffff) << 12) as u32 | u32::from(state.opcode & 0x7ff),
            );
            put_word(&mut bytes, 20, dp as u16);
            put_dword(&mut bytes, 24, (((dp >> 16) & 0xffff) << 12) as u32);
        }
        _ => unreachable!(),
    }
    if operation.kind == Kind::Save {
        let at = operation.format.environment_bytes() as usize;
        for logical in 0..8 {
            bytes[at + logical * 10..at + (logical + 1) * 10]
                .copy_from_slice(&state.registers[(state.top() + logical) & 7]);
        }
    }
    bytes
}

pub(super) fn restore(operation: ImageOp, bytes: &[u8; 512], state: &mut X87State) {
    let short = operation.format.environment_bytes() == 14;
    state.control_word = word(bytes, 0);
    state.status_word = word(bytes, if short { 2 } else { 4 });
    let tags = word(bytes, if short { 4 } else { 8 });
    match operation.format {
        Format::Protected16 => {
            state.instruction_pointer = u64::from(word(bytes, 6));
            state.data_pointer = u64::from(word(bytes, 10));
        }
        Format::Protected32 => {
            state.instruction_pointer = u64::from(dword(bytes, 12));
            state.opcode = word(bytes, 18) & 0x7ff;
            state.data_pointer = u64::from(dword(bytes, 20));
        }
        Format::Real16 => {
            state.instruction_pointer =
                u64::from(word(bytes, 6)) | (u64::from(word(bytes, 8) & 0xf000) << 4);
            state.opcode = word(bytes, 8) & 0x7ff;
            state.data_pointer =
                u64::from(word(bytes, 10)) | (u64::from(word(bytes, 12) & 0xf000) << 4);
        }
        Format::Real32 => {
            state.instruction_pointer =
                u64::from(word(bytes, 12)) | (u64::from(dword(bytes, 16) & 0x0ffff000) << 4);
            state.opcode = dword(bytes, 16) as u16 & 0x7ff;
            state.data_pointer =
                u64::from(word(bytes, 20)) | (u64::from(dword(bytes, 24) & 0x0ffff000) << 4);
        }
        _ => unreachable!(),
    }
    if operation.kind == Kind::Restore {
        let at = operation.format.environment_bytes() as usize;
        for logical in 0..8 {
            state.registers[(state.top() + logical) & 7]
                .copy_from_slice(&bytes[at + logical * 10..at + (logical + 1) * 10]);
        }
    }
    for physical in 0..8 {
        let tag = if (tags >> (2 * physical)) & 3 == 3 {
            3
        } else {
            classify_tag(state.raw(physical))
        };
        state.set_tag(physical, tag);
    }
    state.refresh();
}

use super::*;
use crate::x86::fast_system::{self, Instruction, State};
use crate::x86::paging::ControlFailure;
use crate::x86::protection::{ProtectionFault, ProtectionPhase};

pub(super) fn parse_bank(value: &serde_json::Value) -> Result<State, &'static str> {
    let word = |name| {
        value[name]
            .as_str()
            .and_then(|v| v.strip_prefix("0x"))
            .and_then(|v| u64::from_str_radix(v, 16).ok())
            .ok_or("fast system fields must be unsigned64 hexadecimal words")
    };
    let bank = State {
        star: word("star")?,
        lstar: word("lstar")?,
        fmask: word("fmask")?,
        sysenter_cs: word("sysenterCs")?,
        sysenter_eip: word("sysenterEip")?,
        sysenter_esp: word("sysenterEsp")?,
        kernel_gs_base: word("kernelGsBase")?,
    };
    bank.validate()?;
    Ok(bank)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_fast_system_state() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        if core.paging.is_none() { return bridge.error("fast system state requires a paged CPU"); }
        let bank = core.fast_system;
        bridge.info = serde_json::to_vec(&serde_json::json!({
            "star":format!("0x{:x}",bank.star),"lstar":format!("0x{:x}",bank.lstar),
            "fmask":format!("0x{:x}",bank.fmask),"sysenterCs":format!("0x{:x}",bank.sysenter_cs),
            "sysenterEip":format!("0x{:x}",bank.sysenter_eip),"sysenterEsp":format!("0x{:x}",bank.sysenter_esp),
            "kernelGsBase":format!("0x{:x}",bank.kernel_gs_base),
        })).unwrap();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_import_fast_system() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let bank = match serde_json::from_slice::<serde_json::Value>(&bridge.input)
            .map_err(|_| "invalid fast system input")
            .and_then(|value| parse_bank(&value))
        {
            Ok(bank) => bank,
            Err(message) => return bridge.error(message),
        };
        let core = bridge.core.as_mut().unwrap();
        if core.paging.is_none() {
            return bridge.error("fast system state requires a paged CPU");
        }
        core.fast_system = bank;
        0
    })
}

pub(super) fn failure(core: &mut Core, failure: ControlFailure) -> i32 {
    match failure {
        ControlFailure::Undefined => {
            core.decode_fault = Some(decode::DecodeFault::UndefinedOpcode);
            INVALID
        }
        ControlFailure::GeneralProtection => {
            core.protection_fault = Some(ProtectionFault {
                vector: 13,
                error_code: 0,
                phase: ProtectionPhase::Target,
                selector: None,
            });
            super::super::layout::PROTECTION
        }
        ControlFailure::Unsupported => UNSUPPORTED,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_fast_system(
    kind: u32,
    wide: u32,
    next: u64,
    sp: u64,
    rcx: u64,
    rdx: u64,
    r11: u64,
    flags: u64,
) -> i32 {
    let instruction = match (kind, wide) {
        (0, 0) => Instruction::Syscall,
        (1, 0..=1) => Instruction::Sysret { wide: wide != 0 },
        (2, 0) => Instruction::Sysenter,
        (3, 0..=1) => Instruction::Sysexit { wide: wide != 0 },
        (4, 0) => Instruction::Swapgs,
        _ => return -1,
    };
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let Some(paging) = core.paging else {
            return UNSUPPORTED;
        };
        let mut scalar = crate::x86::state::State {
            flags,
            rip: next,
            ..Default::default()
        };
        for (register, value) in [(4, sp), (1, rcx), (2, rdx), (11, r11)] {
            scalar.registers[register] = value;
        }
        let prepared = match fast_system::prepare(
            instruction,
            core.fast_system,
            &paging,
            &scalar,
            &core.context,
            next,
        ) {
            Ok(prepared) => prepared,
            Err(error) => return failure(core, error),
        };
        if core.context != prepared.context {
            core.image.retire_sources();
            core.observed_owners.clear();
            core.context_version = core.context_version.wrapping_add(1);
        }
        core.context = prepared.context;
        core.fast_system = prepared.bank;
        unsafe {
            let raw = &mut *core.state.get();
            raw.rip = prepared.scalar.rip;
            raw.flags = prepared.scalar.flags;
            for register in [4, 1, 11] {
                raw.registers[register] = prepared.scalar.registers[register];
            }
        }
        0
    })
}

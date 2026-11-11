use super::*;
use crate::embedding::layout::{PROTECTION, SYSTEM_MEMORY};
use crate::x86::instruction::Width;
use crate::x86::protection::{self, Failure};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "io")]
unsafe extern "C" {
    #[link_name = "read"]
    fn port_read(port: u32, width: u32) -> u32;
    #[link_name = "write"]
    fn port_write(port: u32, width: u32, value: u32);
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn port_read(_: u32, _: u32) -> u32 {
    panic!("port provider requires Wasm embedding")
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn port_write(_: u32, _: u32, _: u32) {
    panic!("port provider requires Wasm embedding")
}

#[unsafe(no_mangle)]
pub extern "C" fn core_io_configure(present: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        if present > 1 || core.io_configured {
            return -1;
        }
        core.io_configured = true;
        core.io_present = present != 0;
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_io_effect_active() -> i32 {
    BRIDGE.with_borrow(|bridge| i32::from(bridge.core.as_ref().is_some_and(|core| core.io_effect)))
}

fn permission_failure(core: &mut Core, failure: Failure) -> i32 {
    match failure {
        Failure::Protection(fault) => {
            core.protection_fault = Some(fault);
            PROTECTION
        }
        Failure::SystemMemory(fault) => {
            core.system_memory_fault = Some(fault);
            SYSTEM_MEMORY
        }
        Failure::SystemPaging(fault) => core.system_paging_failure(fault),
        Failure::Operand(_) => unreachable!("I/O permission has no explicit operand"),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_io(
    descriptor: u32,
    port: u32,
    offset: u64,
    value: u64,
    segment: u32,
    flags: u64,
) -> i32 {
    execute::<false>(descriptor, port, offset, value, segment, flags)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_io_observed(
    descriptor: u32,
    port: u32,
    offset: u64,
    value: u64,
    segment: u32,
    flags: u64,
) -> i32 {
    execute::<true>(descriptor, port, offset, value, segment, flags)
}

fn execute<const OBSERVED: bool>(
    descriptor: u32,
    port: u32,
    offset: u64,
    value: u64,
    segment: u32,
    flags: u64,
) -> i32 {
    let kind = descriptor & 3;
    let width = match descriptor >> 2 {
        1 => Width::W8,
        2 => Width::W16,
        4 => Width::W32,
        _ => return -1,
    };
    let Some(segment) = Segment::ALL.get(segment as usize).copied() else {
        return -1;
    };
    if port > 0xffff || kind == 2 && segment != Segment::Es {
        return -1;
    }
    core_clear_fault();
    let prepared = BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let paged = core.paging.is_some();
        if let Err(failure) = guest_semantics!(
            core,
            paged,
            protection::io::admit,
            flags,
            port as u16,
            width
        ) {
            return Err(permission_failure(core, failure));
        }
        if port + u32::from(width.bytes()) > 0x10000 || !core.io_present {
            return Err(UNSUPPORTED);
        }
        let mut data = value & width.mask();
        let address = if kind >= 2 {
            let access = if kind == 2 {
                Access::Write
            } else {
                Access::Read
            };
            let Some(address) =
                core.segment_address(offset, u32::from(width.bytes()), segment, access, false)
            else {
                return Err(if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    core.memory_failure_reason()
                });
            };
            if kind == 3 {
                data = match guest_access!(core, paged, read(address, u32::from(width.bytes()))) {
                    Ok(value) => value,
                    Err(failure) => {
                        core.access_failure(failure);
                        return Err(core.memory_failure_reason());
                    }
                };
                if OBSERVED {
                    core.debug_operand(address, u32::from(width.bytes()), Access::Read);
                }
            }
            address
        } else {
            0
        };
        core.io_effect = true;
        Ok((address, data))
    });
    let (address, data) = match prepared {
        Ok(value) => value,
        Err(reason) => return reason,
    };
    // The provider may throw through Wasm: no bridge/state borrow survives this call.
    let data = unsafe {
        if kind == 0 || kind == 2 {
            u64::from(port_read(port, width.bits()))
        } else {
            port_write(port, width.bits(), data as u32);
            data
        }
    };
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.io_effect = false;
        if kind == 2 {
            let paged = core.paging.is_some();
            if let Err(failure) =
                guest_access!(core, paged, write(address, u32::from(width.bytes()), data))
            {
                core.access_failure(failure);
                return core.memory_failure_reason();
            }
            if OBSERVED {
                core.debug_operand(address, u32::from(width.bytes()), Access::Write);
            }
        }
        unsafe {
            let state = &mut *core.state.get();
            state.vector_scratch[..8].copy_from_slice(&data.to_le_bytes());
        }
        if core.image.active_changed() { 2 } else { 0 }
    })
}

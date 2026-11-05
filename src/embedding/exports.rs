use std::cell::{RefCell, UnsafeCell};

use crate::dbt::{self, CompileError, Limits};
use crate::memory::{Access, Cause, Fault, Image};
use crate::x86::decode::{self, DecodeError};
use crate::x86::instruction::Operation;
use crate::x86::state::State;

use super::layout::{FETCH, INVALID, RESOURCE, RunState, TARGET, UNSUPPORTED};

struct Core {
    image: Image,
    state: Box<UnsafeCell<RunState>>,
    fault: Option<Fault>,
}

#[derive(Default)]
struct Bridge {
    core: Option<Core>,
    input: Vec<u8>,
    output: Vec<u8>,
    info: Vec<u8>,
}

impl Bridge {
    fn error(&mut self, message: &str) -> i32 {
        self.info = serde_json::to_vec(&serde_json::json!({ "error": message })).unwrap();
        1
    }
}

thread_local! {
    static BRIDGE: RefCell<Bridge> = RefCell::default();
}

fn fault_json(fault: &Fault) -> serde_json::Value {
    serde_json::json!({
        "address": format!("0x{:x}", fault.address),
        "width": fault.width,
        "access": match fault.access { Access::Read => "read", Access::Write => "write", Access::Execute => "execute" },
        "cause": match fault.cause { Cause::AddressRange => "address-range", Cause::Noncanonical => "noncanonical", Cause::Unmapped => "unmapped", Cause::Permission => "permission" },
        "failingAddress": format!("0x{:x}", fault.failing),
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_input(length: u32) -> u32 {
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input.resize(length as usize, 0);
        bridge.input.as_mut_ptr() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_init(code_base: u64, code_len: u32, ram_base: u64, ram_len: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let Some(total) = code_len.checked_add(ram_len) else {
            return bridge.error("combined image exceeds wasm32 input size");
        };
        if bridge.input.len() != total as usize {
            return bridge.error("image input length differs");
        }
        let code = bridge.input[..code_len as usize].to_vec();
        let ram = bridge.input[code_len as usize..].to_vec();
        let image = match Image::new(code_base, code, ram_base, ram) {
            Ok(image) => image,
            Err(message) => return bridge.error(message),
        };
        let state = Box::new(UnsafeCell::new(RunState {
            rip: code_base,
            ..RunState::default()
        }));
        bridge.core = Some(Core {
            image,
            state,
            fault: None,
        });
        bridge.info = serde_json::to_vec(&RunState::descriptor()).unwrap();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_state_ptr() -> u32 {
    BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().state.get() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_import_state() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        if bridge.input.len() != size_of::<RunState>() {
            return bridge.error("state input length differs");
        }
        let word =
            |offset| u64::from_le_bytes(bridge.input[offset..offset + 8].try_into().unwrap());
        let state = State {
            registers: std::array::from_fn(|i| {
                word(std::mem::offset_of!(RunState, registers) + i * 8)
            }),
            flags: word(std::mem::offset_of!(RunState, flags)),
            rip: word(std::mem::offset_of!(RunState, rip)),
        };
        if let Err(message) = state.validate() {
            return bridge.error(message);
        }
        let core = bridge.core.as_mut().unwrap();
        // generated execution is suspended for every export call. no reference to
        // this foreign-mutable buffer survives the call back into generated wasm.
        unsafe { (&mut *core.state.get()).import(state) };
        core.fault = None;
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_clear_fault() {
    BRIDGE.with_borrow_mut(|bridge| bridge.core.as_mut().unwrap().fault = None);
}

#[unsafe(no_mangle)]
pub extern "C" fn core_probe(pc: u64) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        match decode::decode(pc, |address| core.image.fetch(address)) {
            Ok(_) => 0,
            Err(DecodeError::Unsupported) => UNSUPPORTED,
            Err(DecodeError::Invalid) => INVALID,
            Err(DecodeError::Fetch(fault)) => {
                core.fault = Some(fault);
                FETCH
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_compile(
    pc: u64,
    max_instructions: u32,
    max_source_bytes: u32,
    max_artifact_bytes: u32,
) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.output.clear();
        let core = bridge.core.as_ref().unwrap();
        let limits = Limits { max_instructions, max_source_bytes, max_artifact_bytes };
        match dbt::compile(&core.image, pc, limits) {
            Ok(artifact) => {
                bridge.info = serde_json::to_vec(&serde_json::json!({
                    "entries": artifact.entries.iter().map(|pc| format!("0x{pc:x}")).collect::<Vec<_>>(),
                    "instructionCount": artifact.instruction_count,
                    "blockCount": artifact.block_count,
                    "sourceBytes": artifact.source_bytes,
                })).unwrap();
                bridge.output = artifact.bytes;
                0
            }
            Err(CompileError::Resource) => RESOURCE,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_load(address: u64, width: u32) -> u64 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        match core.image.read(address, width) {
            Ok(value) => value,
            Err(fault) => {
                core.fault = Some(fault);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_store(address: u64, width: u32, value: u64) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        match core.image.write(address, width, value) {
            Ok(()) => 1,
            Err(fault) => {
                core.fault = Some(fault);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_access_failed() -> i32 {
    BRIDGE.with_borrow(|bridge| i32::from(bridge.core.as_ref().unwrap().fault.is_some()))
}

#[unsafe(no_mangle)]
pub extern "C" fn core_fault_info(reason: i32) {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let target_fault = if reason == TARGET {
            // this diagnostic runs after the generated invocation has returned.
            let rip = unsafe { (*core.state.get()).rip };
            match decode::decode(rip, |address| core.image.fetch(address)) {
                Ok(instruction) => match instruction.operation {
                    Operation::Jump { target } | Operation::Jnz { target } => Some(Fault {
                        address: target,
                        width: 0,
                        access: Access::Execute,
                        cause: Cause::Noncanonical,
                        failing: u128::from(target),
                    }),
                    _ => None,
                },
                Err(_) => None,
            }
        } else {
            None
        };
        bridge.info = serde_json::to_vec(
            &core
                .fault
                .as_ref()
                .or(target_fault.as_ref())
                .map(fault_json),
        )
        .unwrap();
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_read_memory(address: u64, length: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        match bridge
            .core
            .as_ref()
            .unwrap()
            .image
            .read_bytes(address, length)
        {
            Ok(bytes) => {
                bridge.output = bytes;
                0
            }
            Err(fault) => {
                bridge.info = serde_json::to_vec(&fault_json(&fault)).unwrap();
                1
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_write_memory(address: u64) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let Bridge {
            core, input, info, ..
        } = bridge;
        match core.as_mut().unwrap().image.write_bytes(address, input) {
            Ok(()) => 0,
            Err(fault) => {
                *info = serde_json::to_vec(&fault_json(&fault)).unwrap();
                1
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_output_ptr() -> u32 {
    BRIDGE.with_borrow(|bridge| bridge.output.as_ptr() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_output_len() -> u32 {
    BRIDGE.with_borrow(|bridge| bridge.output.len() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_info_ptr() -> u32 {
    BRIDGE.with_borrow(|bridge| bridge.info.as_ptr() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_info_len() -> u32 {
    BRIDGE.with_borrow(|bridge| bridge.info.len() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_dispose() {
    BRIDGE.with_borrow_mut(|bridge| *bridge = Bridge::default());
}

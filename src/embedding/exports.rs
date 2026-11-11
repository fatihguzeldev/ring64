use std::cell::{RefCell, UnsafeCell};

use crate::dbt::{self, CompileError, Limits};
use crate::memory::{Access, Cause, Fault, Image};
use crate::x86::context::{AccessFailure, ExecutionContext, Segment, SegmentCause, SegmentFault};
use crate::x86::decode::{self, DecodeError};
use crate::x86::state::State;

use super::layout::{
    DATA, FETCH, INVALID, RESOURCE, RawEventState, RawInterruptState, RunState, SCALAR_STATE_SIZE,
    SEGMENT, TARGET, UNSUPPORTED,
};

macro_rules! guest_access {
    ($core:expr, $paged:expr, $method:ident($($argument:expr),* $(,)?)) => {{
        if $paged {
            let cpl = $core.context.cpl();
            let mut memory = crate::x86::paging::access::Memory::new(
                &mut $core.image, $core.paging.as_ref().expect("paged helper profile"),
                cpl, &mut $core.paging_work,
            );
            crate::x86::access::GuestMemory::$method(&mut memory, $($argument),*)
        } else {
            $core.image.$method($($argument),*).map_err(AccessFailure::Linear)
        }
    }};
}

macro_rules! guest_semantics {
    ($core:expr,$paged:expr,$operation:path,$($argument:expr),* $(,)?) => {{
        if $paged {
            let cpl=$core.context.cpl();
            let mut memory=crate::x86::paging::access::Memory::new(&mut $core.image,$core.paging.as_ref().expect("paged helper profile"),cpl,&mut $core.paging_work);
            $operation(&mut $core.context,&mut memory,$($argument),*)
        } else {$operation(&mut $core.context,&mut $core.image,$($argument),*)}
    }};
}

mod admission;
mod context;
mod debug;
mod exception_delivery;
mod external_interrupts;
mod far_control;
mod fast_system;
mod io;
mod mapped;
mod mmx;
mod numeric;
mod numeric_controls;
mod numeric_image;
mod paging;
mod protection;
mod reset;
mod software_events;
mod streaming;
mod system_flags;
mod translation;
mod vector;
mod x87;
mod x87_state;

struct Core {
    io_present: bool,
    io_configured: bool,
    io_effect: bool,
    image: Image,
    fast_system: crate::x86::fast_system::State,
    paging: Option<crate::x86::paging::State>,
    physical_controls: bool,
    paging_work: crate::x86::paging::access::AccessState,
    paging_failure: Option<crate::x86::paging::walk::Failure>,
    pdpte_load_fault: Option<(u8, u8, Fault)>,
    paging_system: Option<crate::x86::protection::SystemPagingFault>,
    state: Box<UnsafeCell<RunState>>,
    fault: Option<Fault>,
    divide_failed: bool,
    decode_fault: Option<decode::DecodeFault>,
    context: ExecutionContext,
    context_version: u64,
    segment_fault: Option<SegmentFault>,
    alignment_fault: Option<vector::AlignmentFault>,
    simd_exception: Option<numeric::SimdException>,
    numeric_fault: Option<crate::x86::numeric_controls::Fault>,
    numeric_form: Option<(crate::x86::numeric_controls::Family, u64)>,
    general_protection: Option<numeric::GeneralProtectionFault>,
    protection_fault: Option<crate::x86::protection::ProtectionFault>,
    system_memory_fault: Option<crate::x86::protection::SystemMemoryFault>,
    debug_exception: Option<system_flags::DebugException>,
    translation_owners: dbt::Owners,
    debug_candidate: u8,
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
            io_present: false,
            io_configured: false,
            io_effect: false,
            image,
            fast_system: Default::default(),
            paging: None,
            physical_controls: false,
            paging_work: Default::default(),
            paging_failure: None,
            pdpte_load_fault: None,
            paging_system: None,
            state,
            fault: None,
            divide_failed: false,
            decode_fault: None,
            context: ExecutionContext::default(),
            context_version: 0,
            segment_fault: None,
            alignment_fault: None,
            simd_exception: None,
            numeric_fault: None,
            numeric_form: None,
            general_protection: None,
            protection_fault: None,
            system_memory_fault: None,
            debug_exception: None,
            translation_owners: Default::default(),
            debug_candidate: 0,
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
        let event_end = SCALAR_STATE_SIZE + size_of::<RawEventState>();
        let old_end = event_end + size_of::<RawInterruptState>();
        let source_end = old_end + size_of::<super::layout::debug::DebugSource>();
        let new_end = source_end + size_of::<super::layout::debug::Continuation>();
        let paging_end = new_end + size_of::<super::layout::paging::RawPagingSource>();
        let numeric_end = paging_end + size_of::<super::layout::numeric::RawNumericSource>();
        if bridge.input.len() != SCALAR_STATE_SIZE
            && bridge.input.len() != event_end
            && bridge.input.len() != old_end
            && bridge.input.len() != new_end
            && bridge.input.len() != paging_end
            && bridge.input.len() != numeric_end
        {
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
        let offset = std::mem::offset_of!(RunState, interruptibility);
        let interruptibility =
            u32::from_le_bytes(bridge.input[offset..offset + 4].try_into().unwrap());
        if let Err(message) = state.validate() {
            return bridge.error(message);
        }
        if !crate::x86::flags::valid_interruptibility(state.flags, interruptibility) {
            return bridge.error("invalid interruptibility for imported flags");
        }
        let event = if bridge.input.len() == SCALAR_STATE_SIZE {
            RawEventState::default()
        } else {
            match RawEventState::from_bytes(&bridge.input[SCALAR_STATE_SIZE..event_end]) {
                Ok(raw) => raw,
                Err(message) => return bridge.error(message),
            }
        };
        let interrupts = if bridge.input.len() > event_end {
            match RawInterruptState::from_bytes(&bridge.input[event_end..old_end]) {
                Ok(raw) => raw,
                Err(message) => return bridge.error(message),
            }
        } else {
            RawInterruptState::default()
        };
        let decoded_interrupts = match interrupts.decode() {
            Ok(state) => state,
            Err(message) => return bridge.error(message),
        };
        let (source, continuation) = if bridge.input.len() >= new_end {
            let source = match super::layout::debug::DebugSource::from_bytes(
                &bridge.input[old_end..source_end],
            ) {
                Ok(s) => s,
                Err(e) => return bridge.error(e),
            };
            let continuation = match super::layout::debug::Continuation::from_bytes(
                &bridge.input[source_end..new_end],
            ) {
                Ok(s) => s,
                Err(e) => return bridge.error(e),
            };
            (source, continuation)
        } else {
            (
                super::layout::debug::DebugSource::default(),
                super::layout::debug::Continuation::default(),
            )
        };
        let mut decoded = match event.decode() {
            Ok(event) => event,
            Err(message) => return bridge.error(message),
        };
        if let crate::x86::exception::EventState::Pending(ref mut pending) = decoded {
            pending.debug = source.decode().unwrap();
        } else if source != super::layout::debug::DebugSource::default() {
            return bridge.error("debug source requires pending exception");
        }
        let paging_source = if bridge.input.len() >= paging_end {
            match super::layout::paging::RawPagingSource::from_bytes(
                &bridge.input[new_end..paging_end],
            ) {
                Ok(source) => source,
                Err(message) => return bridge.error(message),
            }
        } else {
            super::layout::paging::RawPagingSource::default()
        };
        let numeric_source = if bridge.input.len() == numeric_end {
            match super::layout::numeric::RawNumericSource::from_bytes(
                &bridge.input[paging_end..numeric_end],
            ) {
                Ok(source) => source,
                Err(message) => return bridge.error(message),
            }
        } else {
            Default::default()
        };
        if let Err(message) = numeric_source.attach(&mut decoded) {
            return bridge.error(message);
        }
        if let Err(message) = paging_source.attach(&mut decoded) {
            return bridge.error(message);
        }
        if matches!(decoded, crate::x86::exception::EventState::Pending(event) if event.vector==14)
            && bridge.core.as_ref().unwrap().paging.is_none()
        {
            return bridge.error("page fault source requires paged execution");
        }
        if let Err(message) = decoded.validate(
            state.rip,
            state.flags,
            &bridge.core.as_ref().unwrap().context,
            interruptibility,
            decoded_interrupts,
        ) {
            return bridge.error(message);
        }
        if let Err(message) = continuation.validate(
            interruptibility,
            decoded == crate::x86::exception::EventState::Ready,
        ) {
            return bridge.error(message);
        }
        let core = bridge.core.as_mut().unwrap();
        // generated execution is suspended for every export call. no reference to
        // this foreign-mutable buffer survives the call back into generated wasm.
        unsafe {
            let target = &mut *core.state.get();
            target.import(state);
            target.interruptibility = interruptibility;
            target.set_event(decoded);
            target.debug.continuation = continuation;
            target.interrupts = interrupts;
        };
        core.fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.numeric_fault = None;
        core.numeric_form = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.divide_failed = false;
        core.segment_fault = None;
        core.debug_exception = None;
        core.decode_fault = None;
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_clear_fault() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.paging_failure = None;
        core.pdpte_load_fault = None;
        core.paging_system = None;
        core.debug_candidate = 0;
        core.fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.numeric_fault = None;
        core.numeric_form = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.divide_failed = false;
        core.decode_fault = None;
        core.segment_fault = None;
        core.debug_exception = None;
        unsafe {
            (*core.state.get()).target = 0;
            (*core.state.get()).fault_segment = Segment::Cs as u32;
        };
        i32::from(core.boundary_observed())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_probe(pc: u64) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.debug_candidate = 0;
        core.fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.numeric_fault = None;
        core.numeric_form = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.segment_fault = None;
        core.decode_fault = None;
        unsafe { (*core.state.get()).fault_segment = Segment::Cs as u32 };
        let (flags, shadow) = unsafe {
            (
                (*core.state.get()).flags,
                (*core.state.get()).interruptibility,
            )
        };
        let debug = core.debug_execute(pc, flags, shadow);
        if debug != 0 {
            return debug;
        }
        let decoded = if core.paging.is_some() {
            core.paged_decode(pc)
        } else {
            decode::decode_with_context(pc, &core.context, |offset| {
                core.context
                    .fetch(&core.image, offset)
                    .map_err(|failure| match failure {
                        AccessFailure::Linear(fault) => DecodeError::Fetch(fault),
                        AccessFailure::Segment(fault) => DecodeError::Segment(fault),
                        AccessFailure::Paging(fault) => DecodeError::Paging(fault),
                    })
            })
        };
        core.decode_fault = decoded
            .as_ref()
            .err()
            .and_then(|error| error.architectural_fault());
        match decoded {
            Err(DecodeError::PagingRestart) => 26,
            Err(DecodeError::Paging(failure)) => core.paging_failure(failure),
            Ok(instruction) => core.instruction_admission(instruction.operation, pc),
            Err(DecodeError::Segment(fault)) => {
                core.segment_fault = Some(fault);
                SEGMENT
            }
            Err(DecodeError::Unsupported) => UNSUPPORTED,
            Err(DecodeError::Undefined) => UNSUPPORTED,
            Err(
                DecodeError::UndefinedEncoding
                | DecodeError::Invalid
                | DecodeError::InstructionLength,
            ) => INVALID,
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
        let core = bridge.core.as_mut().unwrap();
        let limits = Limits { max_instructions, max_source_bytes, max_artifact_bytes };
        let observed = core.boundary_observed();
        match dbt::compile_with_paging(&core.image, &core.context, core.paging.as_ref(), pc, limits, observed) {
            Ok(artifact) => {
                let owner = match core.image.register_dependencies(
                    artifact.source_ranges.iter().map(|range| (range.start, range.length)),
                    artifact.read_dependencies.iter().map(|range| (range.start, range.length)),
                ) {
                    Ok(owner) => owner,
                    Err(_) => return RESOURCE,
                };
                if !core.translation_owners.register(owner, &core.context, observed, core.context_version) {
                    core.image.release(owner);
                    return RESOURCE;
                }
                bridge.info = serde_json::to_vec(&serde_json::json!({
                    "entries": artifact.entries.iter().map(|pc| format!("0x{pc:x}")).collect::<Vec<_>>(),
                    "instructionCount": artifact.instruction_count,
                    "blockCount": artifact.block_count,
                    "sourceBytes": artifact.source_bytes,
                    "owner": format!("0x{owner:x}"),
                    "contextVersion": format!("0x{:x}",core.context_version),
                    "boundaryObserved": observed,
                    "dependencies": artifact.source_ranges.iter().map(|range| serde_json::json!({
                        "start": format!("0x{:x}", range.start), "length": range.length,
                    })).collect::<Vec<_>>(),
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
    core_load_impl::<false, false>(address, width)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_load_observed(address: u64, width: u32) -> u64 {
    core_load_impl::<true, false>(address, width)
}

fn core_load_impl<const OBSERVED: bool, const PAGED: bool>(address: u64, width: u32) -> u64 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        match guest_access!(core, PAGED, read(address, width)) {
            Ok(value) => {
                if OBSERVED {
                    core.debug_operand(address, width, Access::Read);
                }
                value
            }
            Err(fault) => {
                core.access_failure(fault);
                unsafe {
                    (*core.state.get()).fault_segment = Segment::Ds as u32;
                }
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_load_for_write(address: u64, width: u32) -> u64 {
    core_load_for_write_impl::<false, false>(address, width)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_load_for_write_observed(address: u64, width: u32) -> u64 {
    core_load_for_write_impl::<true, false>(address, width)
}

fn core_load_for_write_impl<const OBSERVED: bool, const PAGED: bool>(
    address: u64,
    width: u32,
) -> u64 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        match guest_access!(core, PAGED, read_for_write(address, width)) {
            Ok(value) => {
                if OBSERVED {
                    core.debug_operand(address, width, Access::Read);
                }
                value
            }
            Err(fault) => {
                core.access_failure(fault);
                unsafe {
                    (*core.state.get()).fault_segment = Segment::Ds as u32;
                }
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_store(address: u64, width: u32, value: u64) -> i32 {
    core_store_impl::<false, false>(address, width, value)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_store_observed(address: u64, width: u32, value: u64) -> i32 {
    core_store_impl::<true, false>(address, width, value)
}

fn core_store_impl<const OBSERVED: bool, const PAGED: bool>(
    address: u64,
    width: u32,
    value: u64,
) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        match guest_access!(core, PAGED, write(address, width, value)) {
            Ok(()) => {
                if OBSERVED {
                    core.debug_operand(address, width, Access::Write);
                }
                if core.image.active_changed() { 2 } else { 1 }
            }
            Err(fault) => {
                core.access_failure(fault);
                unsafe {
                    (*core.state.get()).fault_segment = Segment::Ds as u32;
                }
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
pub extern "C" fn core_segmented_access_failed() -> i32 {
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        i32::from(core.fault.is_some() || core.segment_fault.is_some())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_multiply_high(left: u64, right: u64, signed: i32) -> u64 {
    super::arithmetic::multiply_high(left, right, signed != 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_divide(high: u64, low: u64, divisor: u64, signed: i32) -> u64 {
    let result = super::arithmetic::divide(high, low, divisor, signed != 0);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.core.as_mut().unwrap().divide_failed = result.is_none();
    });
    result.unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_divide_failed() -> i32 {
    BRIDGE.with_borrow(|bridge| i32::from(bridge.core.as_ref().unwrap().divide_failed))
}

#[unsafe(no_mangle)]
pub extern "C" fn core_fault_info(reason: i32) {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let fault = match reason {
            super::layout::PAGE_FAULT | super::layout::PHYSICAL_MEMORY => {
                core.paging_failure_json()
            }
            super::layout::DEBUG_EXCEPTION => core
                .debug_exception
                .as_ref()
                .map(system_flags::DebugException::json),
            super::layout::X87_EXCEPTION => unsafe {
                x87_state::exception_json(&(*core.state.get()).x87)
            },
            super::layout::SIMD_EXCEPTION => core
                .simd_exception
                .as_ref()
                .map(numeric::SimdException::json),
            super::layout::GENERAL_PROTECTION => core
                .general_protection
                .as_ref()
                .map(numeric::GeneralProtectionFault::json),
            super::layout::ALIGNMENT => core
                .alignment_fault
                .as_ref()
                .map(vector::AlignmentFault::json),
            super::layout::PROTECTION => core.protection_fault.as_ref().map(protection::fault_json),
            super::layout::SYSTEM_MEMORY => core
                .system_memory_fault
                .as_ref()
                .map(protection::system_fault_json),
            SEGMENT => core.segment_fault.as_ref().map(context::segment_fault_json),
            DATA | FETCH => core.fault.as_ref().map(fault_json),
            TARGET => {
                let target = unsafe { (*core.state.get()).target };
                Some(fault_json(&Fault {
                    address: target,
                    width: 0,
                    access: Access::Execute,
                    cause: Cause::Noncanonical,
                    failing: u128::from(target),
                }))
            }
            _ => None,
        };
        let fault = fault.map(|mut value| {
            if matches!(reason, DATA | FETCH | TARGET) {
                let segment = if reason == TARGET {
                    Segment::Cs
                } else {
                    Segment::from_id(unsafe { (*core.state.get()).fault_segment })
                };
                value["segment"] = serde_json::json!(segment.name());
            }
            value
        });
        bridge.info = serde_json::to_vec(&fault).unwrap();
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_read_memory(address: u64, length: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        match if core.paging.is_some() {
            core.image.physical_read_bytes(address, length)
        } else {
            core.image.read_bytes(address, length)
        } {
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
        let core = core.as_mut().unwrap();
        match if core.paging.is_some() {
            core.image.physical_write_bytes(address, input)
        } else {
            core.image.write_bytes(address, input)
        } {
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

#[cfg(test)]
mod tests;

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_load(address: u64, width: u32) -> u64 {
    core_load_impl::<false, true>(address, width)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_load_observed(address: u64, width: u32) -> u64 {
    core_load_impl::<true, true>(address, width)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_load_for_write(address: u64, width: u32) -> u64 {
    core_load_for_write_impl::<false, true>(address, width)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_load_for_write_observed(address: u64, width: u32) -> u64 {
    core_load_for_write_impl::<true, true>(address, width)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_store(address: u64, width: u32, value: u64) -> i32 {
    core_store_impl::<false, true>(address, width, value)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_store_observed(address: u64, width: u32, value: u64) -> i32 {
    core_store_impl::<true, true>(address, width, value)
}

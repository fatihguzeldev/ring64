use serde_json::Value;

use super::*;
use crate::memory::{MappingInput, MemoryError, MemoryLimits, Permissions};

fn memory_error(bridge: &mut Bridge, error: MemoryError) -> i32 {
    bridge.error(error.message());
    match error {
        MemoryError::Invalid(_) => 1,
        MemoryError::Capacity(_) => 2,
    }
}

fn invalid() -> MemoryError {
    MemoryError::Invalid("invalid mapped memory input")
}
fn json(bytes: &[u8]) -> Result<Value, MemoryError> {
    serde_json::from_slice(bytes).map_err(|_| invalid())
}
fn word(value: &Value) -> Result<u32, MemoryError> {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(invalid)
}
fn name(value: &Value) -> Result<&str, MemoryError> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(invalid)
}
fn array(value: &Value) -> Result<&Vec<Value>, MemoryError> {
    value.as_array().ok_or_else(invalid)
}
fn copy(bytes: &[u8]) -> Result<Vec<u8>, MemoryError> {
    let mut owned = Vec::new();
    owned
        .try_reserve_exact(bytes.len())
        .map_err(|_| MemoryError::Capacity("backing allocation refused"))?;
    owned.extend_from_slice(bytes);
    Ok(owned)
}

fn mappings(value: &Value, capacity: usize) -> Result<Vec<MappingInput>, MemoryError> {
    let inputs = array(value)?;
    if inputs.len() > capacity {
        return Err(MemoryError::Capacity("mapping capacity exceeded"));
    }
    let mut mappings = Vec::new();
    mappings
        .try_reserve_exact(inputs.len())
        .map_err(|_| MemoryError::Capacity("mapping allocation refused"))?;
    for input in inputs {
        let base = input["base"]
            .as_str()
            .and_then(|value| value.strip_prefix("0x"))
            .and_then(|value| u64::from_str_radix(value, 16).ok())
            .ok_or_else(invalid)?;
        let permissions = &input["permissions"];
        mappings.push(MappingInput {
            base,
            backing: name(&input["backing"])?.into(),
            offset: word(&input["offset"])?,
            length: word(&input["length"])?,
            permissions: Permissions {
                read: permissions["read"].as_bool().ok_or_else(invalid)?,
                write: permissions["write"].as_bool().ok_or_else(invalid)?,
                execute: permissions["execute"].as_bool().ok_or_else(invalid)?,
            },
        });
    }
    Ok(mappings)
}

fn initial_image(
    input: &[u8],
    metadata_len: u32,
) -> Result<
    (
        Image,
        Option<crate::x86::paging::State>,
        crate::x86::fast_system::State,
    ),
    MemoryError,
> {
    let metadata_len = metadata_len as usize;
    let config = json(input.get(..metadata_len).ok_or_else(invalid)?)?;
    let caps = &config["memoryLimits"];
    let limits = MemoryLimits {
        max_backing_bytes: word(&caps["maxBackingBytes"])?,
        max_backings: word(&caps["maxBackings"])?,
        max_mappings: word(&caps["maxMappings"])?,
    };
    if limits.max_backing_bytes == 0 || limits.max_backings == 0 || limits.max_mappings == 0 {
        return Err(invalid());
    }
    let inputs = array(&config["backings"])?;
    if inputs.len() > limits.max_backings as usize {
        return Err(MemoryError::Capacity("backing count capacity exceeded"));
    }
    let maps = mappings(&config["mappings"], limits.max_mappings as usize)?;
    let total = inputs.iter().try_fold(0u64, |total, input| {
        Ok::<_, MemoryError>(total + u64::from(word(&input["length"])?))
    })?;
    if total > u64::from(limits.max_backing_bytes) {
        return Err(MemoryError::Capacity("backing byte capacity exceeded"));
    }
    if total != (input.len() - metadata_len) as u64 {
        return Err(invalid());
    }
    let mut backings = Vec::new();
    backings
        .try_reserve_exact(inputs.len())
        .map_err(|_| MemoryError::Capacity("backing allocation refused"))?;
    let mut cursor = metadata_len;
    for description in inputs {
        let length = word(&description["length"])? as usize;
        let id = name(&description["id"])?;
        backings.push((id.into(), copy(&input[cursor..cursor + length])?));
        cursor += length;
    }
    match config.get("memoryModel") {
        None | Some(Value::String(_))
            if config.get("memoryModel").is_none_or(|v| v == "linear") =>
        {
            if config.get("paging").is_some() || config.get("fastSystem").is_some() {
                return Err(invalid());
            }
            Image::mapped(backings, maps, limits).map(|image| (image, None, Default::default()))
        }
        Some(Value::String(model)) if model == "ia32e-paged" => {
            let state =
                super::paging::parse_bank(&config["paging"]).map_err(MemoryError::Invalid)?;
            let fast_system = config
                .get("fastSystem")
                .map(super::fast_system::parse_bank)
                .transpose()
                .map_err(MemoryError::Invalid)?
                .unwrap_or_default();
            Image::physical_mapped(backings, maps, limits)
                .map(|image| (image, Some(state), fast_system))
        }
        _ => Err(invalid()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_init_mapped(entry: u64, metadata_len: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let (image, paging, fast_system) = match initial_image(&bridge.input, metadata_len) {
            Ok(image) => image,
            Err(error) => return memory_error(bridge, error),
        };
        bridge.core = Some(Core {
            io_present: false,
            io_configured: false,
            io_effect: false,
            image,
            fast_system,
            paging,
            paging_work: Default::default(),
            paging_failure: None,
            paging_system: None,
            state: Box::new(UnsafeCell::new(RunState {
                rip: entry,
                ..RunState::default()
            })),
            fault: None,
            divide_failed: false,
            decode_fault: None,
            context: ExecutionContext::default(),
            context_version: 0,
            segment_fault: None,
            alignment_fault: None,
            simd_exception: None,
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
pub extern "C" fn core_add_backing(metadata_len: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let result = (|| {
            let metadata_len = metadata_len as usize;
            let config = json(bridge.input.get(..metadata_len).ok_or_else(invalid)?)?;
            let id = name(&config["id"])?;
            let input = &bridge.input[metadata_len..];
            let image = &mut bridge.core.as_mut().unwrap().image;
            image.check_backing(id, input.len())?;
            image.add_backing(id.into(), copy(input)?)
        })();
        match result {
            Ok(()) => 0,
            Err(error) => memory_error(bridge, error),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_remove_backing() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let result = (|| {
            let id = json(&bridge.input)?;
            bridge
                .core
                .as_mut()
                .unwrap()
                .image
                .remove_backing(name(&id)?)
        })();
        match result {
            Ok(()) => 0,
            Err(error) => memory_error(bridge, error),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_set_mappings() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let result = (|| {
            let image = &mut bridge.core.as_mut().unwrap().image;
            let inputs = mappings(&json(&bridge.input)?, image.mapping_capacity())?;
            image.set_mappings(inputs)
        })();
        match result {
            Ok(()) => 0,
            Err(error) => memory_error(bridge, error),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_validity(owner: u64) -> i32 {
    BRIDGE.with_borrow(|bridge| i32::from(bridge.core.as_ref().unwrap().owner_alive(owner)))
}

#[unsafe(no_mangle)]
pub extern "C" fn core_publish(owner: u64) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| i32::from(bridge.core.as_mut().unwrap().publish_owner(owner)))
}

#[unsafe(no_mangle)]
pub extern "C" fn core_activate(owner: u64) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        i32::from(core.activate_owner(owner))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_release(owner: u64) {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.translation_owners.release(owner);
        core.image.release(owner);
    });
}

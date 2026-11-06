use std::rc::Rc;

use super::address::span_failure;
use super::validity::Validity;

#[derive(Clone, Copy, Debug)]
pub struct MemoryLimits {
    pub max_backing_bytes: u32,
    pub max_backings: u32,
    pub max_mappings: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Permissions {
    pub read: bool,
    pub write: bool,
    pub execute: bool,
}

#[derive(Clone, Debug)]
pub struct MappingInput {
    pub base: u64,
    pub backing: String,
    pub offset: u32,
    pub length: u32,
    pub permissions: Permissions,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryError {
    Invalid(&'static str),
    Capacity(&'static str),
}

impl MemoryError {
    pub fn message(self) -> &'static str {
        match self {
            Self::Invalid(message) | Self::Capacity(message) => message,
        }
    }
}

#[derive(Debug)]
pub struct Image {
    pub(super) backings: Vec<Backing>,
    pub(super) mappings: Vec<Mapping>,
    limits: MemoryLimits,
    pub(super) validity: Validity,
}

#[derive(Debug)]
pub(super) struct Backing {
    pub(super) id: String,
    pub(super) bytes: Vec<u8>,
    pub(super) incarnation: Rc<()>,
}

#[derive(Clone, Debug)]
pub(super) struct Mapping {
    pub(super) base: u64,
    pub(super) backing: usize,
    pub(super) offset: u32,
    pub(super) length: u32,
    pub(super) permissions: Permissions,
}

impl Mapping {
    pub(super) fn end(&self) -> u128 {
        u128::from(self.base) + u128::from(self.length)
    }
}

impl Image {
    pub fn new(
        code_base: u64,
        code: Vec<u8>,
        ram_base: u64,
        ram: Vec<u8>,
    ) -> Result<Self, &'static str> {
        let total = code
            .len()
            .checked_add(ram.len())
            .and_then(|length| u32::try_from(length).ok())
            .ok_or("combined image exceeds wasm32 input size")?;
        let mappings = vec![
            MappingInput {
                base: code_base,
                backing: "code".into(),
                offset: 0,
                length: u32::try_from(code.len()).map_err(|_| "code exceeds wasm32 size")?,
                permissions: Permissions {
                    read: true,
                    write: false,
                    execute: true,
                },
            },
            MappingInput {
                base: ram_base,
                backing: "ram".into(),
                offset: 0,
                length: u32::try_from(ram.len()).map_err(|_| "ram exceeds wasm32 size")?,
                permissions: Permissions {
                    read: true,
                    write: true,
                    execute: false,
                },
            },
        ];
        Self::mapped(
            vec![("code".into(), code), ("ram".into(), ram)],
            mappings,
            MemoryLimits {
                max_backing_bytes: total,
                max_backings: 2,
                max_mappings: 2,
            },
        )
        .map_err(MemoryError::message)
    }

    pub fn mapped(
        backings: Vec<(String, Vec<u8>)>,
        mappings: Vec<MappingInput>,
        limits: MemoryLimits,
    ) -> Result<Self, MemoryError> {
        if limits.max_backing_bytes == 0 || limits.max_backings == 0 || limits.max_mappings == 0 {
            return Err(MemoryError::Invalid(
                "memory limits must be positive wasm32 integers",
            ));
        }
        if backings.len() > limits.max_backings as usize
            || mappings.len() > limits.max_mappings as usize
        {
            return Err(MemoryError::Capacity(
                "initial memory record capacity exceeded",
            ));
        }
        let mut image = Self {
            backings: Vec::new(),
            mappings: Vec::new(),
            limits,
            validity: Validity::default(),
        };
        for (id, bytes) in backings {
            image.add_backing(id, bytes)?;
        }
        image.set_mappings(mappings)?;
        Ok(image)
    }

    pub fn add_backing(&mut self, id: String, bytes: Vec<u8>) -> Result<(), MemoryError> {
        if id.is_empty() || self.backings.iter().any(|backing| backing.id == id) {
            return Err(MemoryError::Invalid(
                "backing name must be nonempty and unique",
            ));
        }
        if bytes.is_empty() || u32::try_from(bytes.len()).is_err() {
            return Err(MemoryError::Invalid(
                "backing bytes must be nonempty and fit wasm32",
            ));
        }
        let total: u64 = self
            .backings
            .iter()
            .map(|backing| backing.bytes.len() as u64)
            .sum();
        if self.backings.len() >= self.limits.max_backings as usize
            || total + bytes.len() as u64 > u64::from(self.limits.max_backing_bytes)
        {
            return Err(MemoryError::Capacity("backing capacity exceeded"));
        }
        self.backings
            .try_reserve(1)
            .map_err(|_| MemoryError::Capacity("backing allocation refused"))?;
        self.backings.push(Backing {
            id,
            bytes,
            incarnation: Rc::new(()),
        });
        Ok(())
    }

    pub fn remove_backing(&mut self, id: &str) -> Result<(), MemoryError> {
        let index = self
            .backings
            .iter()
            .position(|backing| backing.id == id)
            .ok_or(MemoryError::Invalid("unknown backing name"))?;
        if self.mappings.iter().any(|mapping| mapping.backing == index) {
            return Err(MemoryError::Invalid("cannot remove a mapped backing"));
        }
        self.backings.remove(index);
        for mapping in &mut self.mappings {
            if mapping.backing > index {
                mapping.backing -= 1;
            }
        }
        Ok(())
    }

    pub fn set_mappings(&mut self, inputs: Vec<MappingInput>) -> Result<(), MemoryError> {
        if inputs.len() > self.limits.max_mappings as usize {
            return Err(MemoryError::Capacity("mapping capacity exceeded"));
        }
        let mut mappings = Vec::new();
        mappings
            .try_reserve_exact(inputs.len())
            .map_err(|_| MemoryError::Capacity("mapping allocation refused"))?;
        for input in inputs {
            let backing = self
                .backings
                .iter()
                .position(|backing| backing.id == input.backing)
                .ok_or(MemoryError::Invalid("mapping refers to unknown backing"))?;
            if input.length == 0
                || span_failure(input.base, u128::from(input.length)).is_some()
                || u64::from(input.offset) + u64::from(input.length)
                    > self.backings[backing].bytes.len() as u64
            {
                return Err(MemoryError::Invalid(
                    "mapping must be a nonempty canonical nonwrapping backing slice",
                ));
            }
            mappings.push(Mapping {
                base: input.base,
                backing,
                offset: input.offset,
                length: input.length,
                permissions: input.permissions,
            });
        }
        mappings.sort_unstable_by_key(|mapping| mapping.base);
        if mappings
            .windows(2)
            .any(|pair| pair[0].end() > u128::from(pair[1].base))
        {
            return Err(MemoryError::Invalid("guest mappings overlap"));
        }
        self.validity.mapping_change(&self.backings, &mappings);
        self.mappings = mappings;
        Ok(())
    }

    pub(super) fn locate(&self, address: u64) -> Option<&Mapping> {
        locate(&self.mappings, address)
    }
}

pub(super) fn locate(mappings: &[Mapping], address: u64) -> Option<&Mapping> {
    let index = mappings
        .partition_point(|mapping| mapping.base <= address)
        .checked_sub(1)?;
    let mapping = &mappings[index];
    (u128::from(address) < mapping.end()).then_some(mapping)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_spans_can_end_at_the_last_u64_byte() {
        let image = Image::new(u64::MAX - 4, vec![0xb8, 0, 0, 0, 0], 0x1000, vec![0; 8]).unwrap();
        assert_eq!(image.fetch(u64::MAX - 4), Ok(0xb8));
        assert_eq!(
            image.read_bytes(u64::MAX - 4, 5),
            Ok(vec![0xb8, 0, 0, 0, 0])
        );
    }

    #[test]
    fn empty_spans_are_host_input_errors() {
        assert!(Image::new(0x1000, vec![], 0x2000, vec![0]).is_err());
        assert!(Image::new(0x1000, vec![0], 0x2000, vec![]).is_err());
    }

    #[test]
    fn wrapping_and_noncanonical_spans_are_host_input_errors() {
        for (base, bytes) in [
            (u64::MAX, vec![0; 2]),
            (0x0000_8000_0000_0000, vec![0]),
            (0x0000_7fff_ffff_ffff, vec![0; 2]),
            (0xffff_7fff_ffff_ffff, vec![0; 2]),
        ] {
            assert!(Image::new(base, bytes.clone(), 0x2000, vec![0]).is_err());
            assert!(Image::new(0x1000, vec![0], base, bytes).is_err());
        }
    }

    #[test]
    fn overlapping_spans_are_rejected_but_adjacent_spans_are_valid() {
        assert!(Image::new(0x1000, vec![0; 4], 0x1002, vec![0; 4]).is_err());
        assert!(Image::new(0x1002, vec![0; 4], 0x1000, vec![0; 4]).is_err());
        assert!(Image::new(0x1000, vec![0; 4], 0x1000, vec![0; 4]).is_err());
        assert!(Image::new(0x1000, vec![0; 4], 0x1004, vec![0; 4]).is_ok());
        assert!(Image::new(0x1004, vec![0; 4], 0x1000, vec![0; 4]).is_ok());
    }
}

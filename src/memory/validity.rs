use std::collections::BTreeMap;
use std::rc::Rc;

use super::image::{Backing, Mapping, locate};
use super::{Image, MemoryError};

#[derive(Debug)]
struct SourceSlice {
    guest: u64,
    length: u32,
    incarnation: Rc<()>,
    offset: u32,
}

#[derive(Debug)]
struct Owner {
    valid: bool,
    sources: Vec<SourceSlice>,
}

#[derive(Debug)]
pub(super) struct Validity {
    next: u64,
    owners: BTreeMap<u64, Owner>,
    active: Option<u64>,
}

impl Default for Validity {
    fn default() -> Self {
        Self {
            next: 1,
            owners: BTreeMap::new(),
            active: None,
        }
    }
}

impl Validity {
    pub(super) fn write(&mut self, incarnation: &Rc<()>, offset: u32, length: u32) {
        let end = u64::from(offset) + u64::from(length);
        for owner in self.owners.values_mut().filter(|owner| owner.valid) {
            if owner.sources.iter().any(|source| {
                Rc::ptr_eq(&source.incarnation, incarnation)
                    && u64::from(source.offset) < end
                    && u64::from(offset) < u64::from(source.offset) + u64::from(source.length)
            }) {
                owner.valid = false;
            }
        }
    }

    pub(super) fn mapping_change(&mut self, backings: &[Backing], mappings: &[Mapping]) {
        for owner in self.owners.values_mut().filter(|owner| owner.valid) {
            owner.valid = owner
                .sources
                .iter()
                .all(|source| source_current(source, backings, mappings));
        }
    }
}

fn source_current(source: &SourceSlice, backings: &[Backing], mappings: &[Mapping]) -> bool {
    let mut cursor = u128::from(source.guest);
    let end = cursor + u128::from(source.length);
    while cursor < end {
        let Some(mapping) = locate(mappings, cursor as u64) else {
            return false;
        };
        let offset = u64::from(mapping.offset) + (cursor as u64 - mapping.base);
        if !mapping.permissions.execute
            || !Rc::ptr_eq(&backings[mapping.backing].incarnation, &source.incarnation)
            || offset != u64::from(source.offset) + (cursor - u128::from(source.guest)) as u64
        {
            return false;
        }
        cursor = end.min(mapping.end());
    }
    true
}

impl Image {
    pub fn register_source(
        &mut self,
        ranges: impl IntoIterator<Item = (u64, u32)>,
    ) -> Result<u64, MemoryError> {
        let mut sources = Vec::new();
        for (start, length) in ranges {
            if length == 0 || super::address::span_failure(start, u128::from(length)).is_some() {
                return Err(MemoryError::Invalid("invalid artifact source range"));
            }
            let mut cursor = u128::from(start);
            let end = cursor + u128::from(length);
            while cursor < end {
                let mapping = self
                    .locate(cursor as u64)
                    .filter(|mapping| mapping.permissions.execute)
                    .ok_or(MemoryError::Invalid(
                        "artifact source is no longer executable",
                    ))?;
                let count = (end.min(mapping.end()) - cursor) as u32;
                sources
                    .try_reserve(1)
                    .map_err(|_| MemoryError::Capacity("source bookkeeping allocation refused"))?;
                sources.push(SourceSlice {
                    guest: cursor as u64,
                    length: count,
                    incarnation: self.backings[mapping.backing].incarnation.clone(),
                    offset: mapping.offset + (cursor as u64 - mapping.base) as u32,
                });
                cursor += u128::from(count);
            }
        }
        let owner = self.validity.next;
        let next = owner.checked_add(1).ok_or(MemoryError::Capacity(
            "artifact identity capacity exhausted",
        ))?;
        self.validity.owners.insert(
            owner,
            Owner {
                valid: true,
                sources,
            },
        );
        self.validity.next = next;
        Ok(owner)
    }

    pub fn owner_valid(&self, owner: u64) -> bool {
        self.validity
            .owners
            .get(&owner)
            .is_some_and(|owner| owner.valid)
    }

    pub fn activate(&mut self, owner: u64) -> bool {
        if !self.owner_valid(owner) {
            return false;
        }
        self.validity.active = Some(owner);
        true
    }

    pub fn active_changed(&self) -> bool {
        self.validity
            .active
            .is_some_and(|owner| !self.owner_valid(owner))
    }

    pub fn release(&mut self, owner: u64) {
        self.validity.owners.remove(&owner);
        if self.validity.active == Some(owner) {
            self.validity.active = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhausted_compile_identity_never_breaks_a_guest_store_or_reuses_a_token() {
        let mut image = Image::new(0x1000, vec![0xb8, 1, 0, 0, 0], 0x4000, vec![0; 8]).unwrap();
        let owner = image.register_source([(0x1000, 5)]).unwrap();
        image.activate(owner);
        image.validity.next = u64::MAX;
        assert!(matches!(
            image.register_source([(0x1000, 5)]),
            Err(MemoryError::Capacity(_))
        ));
        assert!(image.owner_valid(owner));
        assert_eq!(image.write(0x4000, 8, 0x1234), Ok(()));
        assert_eq!(image.read(0x4000, 8), Ok(0x1234));
        image.release(owner);
        assert!(!image.owner_valid(owner));
    }
}

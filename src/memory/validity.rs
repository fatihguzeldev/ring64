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
    active_invalid: bool,
    sources: BTreeMap<usize, Vec<(u32, u64)>>,
    completed_write: Option<(usize, u32, u64)>,
}

impl Default for Validity {
    fn default() -> Self {
        Self {
            next: 1,
            owners: BTreeMap::new(),
            active: None,
            active_invalid: false,
            sources: BTreeMap::new(),
            completed_write: None,
        }
    }
}

impl Validity {
    fn rebuild_sources(&mut self) {
        self.completed_write = None;
        self.sources.clear();
        for owner in self.owners.values().filter(|owner| owner.valid) {
            for source in &owner.sources {
                self.sources
                    .entry(Rc::as_ptr(&source.incarnation) as usize)
                    .or_default()
                    .push((
                        source.offset,
                        u64::from(source.offset) + u64::from(source.length),
                    ));
            }
        }
        for ranges in self.sources.values_mut() {
            ranges.sort_unstable();
            let mut merged = 0;
            for index in 0..ranges.len() {
                let current = ranges[index];
                if merged > 0 && u64::from(current.0) <= ranges[merged - 1].1 {
                    ranges[merged - 1].1 = ranges[merged - 1].1.max(current.1);
                } else {
                    ranges[merged] = current;
                    merged += 1;
                }
            }
            ranges.truncate(merged);
        }
    }

    pub(super) fn write(&mut self, incarnation: &Rc<()>, offset: u32, length: u32) {
        let end = u64::from(offset) + u64::from(length);
        let identity = Rc::as_ptr(incarnation) as usize;
        if self.completed_write.is_some_and(|(backing, start, limit)| {
            backing == identity && offset >= start && end <= limit
        }) {
            return;
        }
        let Some(ranges) = self.sources.get(&identity) else {
            return;
        };
        let index = ranges.partition_point(|range| u64::from(range.0) < end);
        if index == 0 || ranges[index - 1].1 <= u64::from(offset) {
            return;
        }
        for (&id, owner) in self.owners.iter_mut().filter(|(_, owner)| owner.valid) {
            if owner.sources.iter().any(|source| {
                Rc::ptr_eq(&source.incarnation, incarnation)
                    && u64::from(source.offset) < end
                    && u64::from(offset) < u64::from(source.offset) + u64::from(source.length)
            }) {
                owner.valid = false;
                if self.active == Some(id) {
                    self.active_invalid = true;
                }
            }
        }
        // Every live owner overlapping this span is now invalid; until source
        // registration/remapping/release, writing within it cannot affect another.
        self.completed_write = Some((identity, offset, end));
    }

    pub(super) fn mapping_change(&mut self, backings: &[Backing], mappings: &[Mapping]) {
        for owner in self.owners.values_mut().filter(|owner| owner.valid) {
            owner.valid = owner
                .sources
                .iter()
                .all(|source| source_current(source, backings, mappings));
        }
        self.active_invalid = self
            .active
            .is_some_and(|id| !self.owners.get(&id).is_some_and(|owner| owner.valid));
        self.rebuild_sources();
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
            if length == 0 || self.mapping_span_failure(start, u64::from(length)) {
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
        self.validity.rebuild_sources();
        self.refresh_watchers();
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
        self.validity.active_invalid = false;
        true
    }

    pub fn active_changed(&self) -> bool {
        self.validity.active_invalid
    }

    pub fn retire_sources(&mut self) {
        self.validity.owners.clear();
        self.validity.active = None;
        self.validity.active_invalid = false;
        self.validity.sources.clear();
        self.validity.completed_write = None;
        self.refresh_watchers();
    }

    pub fn release(&mut self, owner: u64) {
        self.validity.owners.remove(&owner);
        if self.validity.active == Some(owner) {
            self.validity.active = None;
            self.validity.active_invalid = false;
        }
        self.validity.rebuild_sources();
        self.refresh_watchers();
    }

    pub(super) fn refresh_watchers(&mut self) {
        for backing in &mut self.backings {
            backing.has_sources = self
                .validity
                .sources
                .contains_key(&(Rc::as_ptr(&backing.incarnation) as usize));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_union_retains_gaps_and_reclaims_released_owners() {
        let mut image = Image::new(0x1000, vec![0; 64], 0x4000, vec![0; 8]).unwrap();
        image
            .set_mappings(vec![super::super::MappingInput {
                base: 0x1000,
                backing: "code".into(),
                offset: 0,
                length: 64,
                permissions: super::super::Permissions {
                    read: true,
                    write: true,
                    execute: true,
                },
            }])
            .unwrap();
        let first = image.register_source([(0x1000, 4)]).unwrap();
        let second = image.register_source([(0x1010, 4)]).unwrap();
        let key = Rc::as_ptr(&image.backings[0].incarnation) as usize;
        assert_eq!(image.validity.sources[&key], [(0, 4), (16, 20)]);
        let bridge = image.register_source([(0x1004, 12)]).unwrap();
        assert_eq!(image.validity.sources[&key], [(0, 20)]);
        image.release(bridge);
        assert_eq!(image.validity.sources[&key], [(0, 4), (16, 20)]);
        image.activate(first);
        image.write(0x1008, 1, 7).unwrap();
        assert!(image.owner_valid(first) && image.owner_valid(second));
        image.write(0x1011, 1, 8).unwrap();
        assert!(image.owner_valid(first));
        assert!(!image.owner_valid(second));
        assert!(!image.active_changed());
        image.release(second);
        assert_eq!(image.validity.sources[&key], [(0, 4)]);
        image.release(first);
        assert!(image.validity.sources.is_empty());
    }

    #[test]
    fn repeated_source_writes_cache_only_a_span_without_live_dependencies() {
        use super::super::{MappingInput, Permissions};
        let mut image = Image::new(0x1000, vec![0; 32], 0x4000, vec![0; 8]).unwrap();
        let permissions = Permissions {
            read: true,
            write: true,
            execute: true,
        };
        let mappings = vec![
            MappingInput {
                base: 0x1000,
                backing: "code".into(),
                offset: 0,
                length: 32,
                permissions,
            },
            MappingInput {
                base: 0x4000,
                backing: "ram".into(),
                offset: 0,
                length: 8,
                permissions,
            },
        ];
        image.set_mappings(mappings.clone()).unwrap();
        let active = image.register_source([(0x1000, 4)]).unwrap();
        let other = image.register_source([(0x1010, 4)]).unwrap();
        let separate = image.register_source([(0x4000, 4)]).unwrap();
        image.activate(active);
        image.write(0x1010, 4, 7).unwrap();
        assert!(!image.owner_valid(other));
        assert!(image.owner_valid(active));
        let completed = image.validity.completed_write;
        assert!(completed.is_some());
        for _ in 0..32 {
            image.write(0x1011, 1, 8).unwrap();
        }
        assert_eq!(image.validity.completed_write, completed);
        assert!(!image.active_changed());
        // A matching backing offset in another incarnation is never cached out.
        image.write(0x4000, 4, 9).unwrap();
        assert!(!image.owner_valid(separate));
        let replacement = image.register_source([(0x1010, 4)]).unwrap();
        assert!(image.validity.completed_write.is_none());
        image.write(0x1011, 1, 10).unwrap();
        assert!(!image.owner_valid(replacement));
        image.release(replacement);
        assert!(image.validity.completed_write.is_none());
        image.write(0x1011, 1, 11).unwrap();
        image.set_mappings(mappings).unwrap();
        assert!(image.validity.completed_write.is_none());
        assert!(image.owner_valid(active));
    }

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

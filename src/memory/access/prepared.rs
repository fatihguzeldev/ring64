use super::{Access, Fault, Image};

/// One originating image's admitted span, valid only while mapping/backing layout is unchanged.
/// Paging retains this only within the current instruction/element's publication boundary.
#[derive(Debug)]
pub(crate) struct PreparedPhysicalWrite {
    address: u64,
    width: u32,
    first: usize,
}

#[derive(Debug)]
pub(crate) struct PreparedPhysicalUpdate(PreparedPhysicalWrite);

impl Image {
    pub(crate) fn prepare_physical_write(
        &self,
        address: u64,
        width: u32,
        rmw: bool,
    ) -> Result<PreparedPhysicalWrite, Fault> {
        let first = self.preflight::<true>(address, width, Access::Write, rmw, false)?;
        Ok(PreparedPhysicalWrite {
            address,
            width,
            first,
        })
    }

    pub(crate) fn prepare_physical_update(
        &self,
        address: u64,
    ) -> Result<PreparedPhysicalUpdate, Fault> {
        self.prepare_physical_write(address, 8, true)
            .map(PreparedPhysicalUpdate)
    }

    pub(crate) fn publish_physical(
        &mut self,
        prepared: &PreparedPhysicalWrite,
        offset: u32,
        bytes: &[u8],
    ) {
        assert!(u64::from(offset) + bytes.len() as u64 <= u64::from(prepared.width));
        if bytes.is_empty() {
            return;
        }
        let address = prepared.address + u64::from(offset);
        let mut first = prepared.first;
        while self.mappings[first].end() <= u128::from(address) {
            first += 1;
        }
        self.write_after_preflight(address, bytes, first);
    }

    pub(crate) fn publish_physical_update(&mut self, prepared: &PreparedPhysicalUpdate, bits: u64) {
        let span = &prepared.0;
        let current = self.scalar_after_preflight(span.address, 8, span.first);
        self.write_after_preflight(span.address, &(current | bits).to_le_bytes(), span.first);
    }
}

#[cfg(test)]
thread_local! { static PREFLIGHTS: std::cell::Cell<usize> = const {std::cell::Cell::new(0)}; }

#[cfg(test)]
pub(super) fn record_preflight() {
    PREFLIGHTS.with(|count| count.set(count.get() + 1));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MappingInput, MemoryLimits, Permissions};

    fn mapping(base: u64, offset: u32, length: u32, read: bool, write: bool) -> MappingInput {
        MappingInput {
            base,
            backing: "data".into(),
            offset,
            length,
            permissions: Permissions {
                read,
                write,
                execute: true,
            },
        }
    }
    fn image(mappings: Vec<MappingInput>) -> Image {
        Image::physical_mapped(
            vec![("data".into(), (0..32).collect())],
            mappings,
            MemoryLimits {
                max_backing_bytes: 32,
                max_backings: 1,
                max_mappings: 8,
            },
        )
        .unwrap()
    }

    #[test]
    fn captured_split_write_publishes_selected_bytes_and_alias_invalidation_without_new_probes() {
        let high = 0x800000000000;
        let mut image = image(vec![
            mapping(0x1000, 6, 2, true, true),
            mapping(high, 4, 4, true, true),
            mapping(high + 4, 16, 4, true, true),
        ]);
        let owner = image.register_source([(0x1000, 2)]).unwrap();
        image.activate(owner);
        let prepared = image.prepare_physical_write(high, 8, false).unwrap();
        let before = PREFLIGHTS.with(|count| count.get());
        image.publish_physical(&prepared, 2, &[0xaa, 0xbb, 0xcc, 0xdd]);
        assert_eq!(
            PREFLIGHTS.with(|count| count.get()),
            before,
            "publication must not privately re-admit any byte"
        );
        assert!(!image.owner_valid(owner));
        assert!(image.active_changed());
        assert_eq!(
            image.physical_read_bytes(high, 8).unwrap(),
            [4, 5, 0xaa, 0xbb, 0xcc, 0xdd, 18, 19]
        );
        assert_eq!(image.physical_read_bytes(0x1000, 2).unwrap(), [0xaa, 0xbb]);
    }

    #[test]
    fn captured_update_ors_current_alias_bytes_and_notifies_sources_without_new_probes() {
        let mut image = image(vec![
            mapping(0x2000, 0, 8, true, true),
            mapping(0x3000, 0, 8, true, true),
        ]);
        image.physical_write(0x2000, 8, 0x1234000000000027).unwrap();
        let prepared = image.prepare_physical_update(0x2000).unwrap();
        image.physical_write(0x3000, 8, 0x9234000000000827).unwrap();
        let owner = image.register_source([(0x3000, 8)]).unwrap();
        image.activate(owner);
        let before = PREFLIGHTS.with(|count| count.get());
        image.publish_physical_update(&prepared, 0x40);
        assert_eq!(
            PREFLIGHTS.with(|count| count.get()),
            before,
            "current-word read and publication use the captured R+W admission"
        );
        assert!(!image.owner_valid(owner));
        assert!(image.active_changed());
        assert_eq!(image.physical_read(0x2000, 8).unwrap(), 0x9234000000000867);
    }

    #[test]
    fn physical_update_admission_requires_read_and_write_but_payload_admission_needs_only_write() {
        let image = image(vec![mapping(0x2000, 0, 8, false, true)]);
        assert!(image.prepare_physical_write(0x2000, 8, false).is_ok());
        assert_eq!(
            image.prepare_physical_update(0x2000).unwrap_err().access,
            Access::Write
        );
        assert!(image.prepare_physical_write(0x2000, 8, true).is_err());
    }
}

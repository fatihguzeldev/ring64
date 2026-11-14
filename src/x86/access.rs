use super::context::AccessFailure;
use crate::memory::Image;

/// A refusal belongs to one captured write in the current preparation batch.
#[derive(Clone, Copy, Debug)]
pub struct PublicationFailure {
    pub index: Option<usize>,
    pub failure: AccessFailure,
}

/// Instruction and system owners share access semantics without choosing a backing plane.
pub trait GuestMemory {
    fn fetch(&self, address: u64) -> Result<u8, AccessFailure>;
    fn read(&self, address: u64, width: u32) -> Result<u64, AccessFailure>;
    fn read_for_write(&self, address: u64, width: u32) -> Result<u64, AccessFailure>;
    fn read_vector(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure>;
    fn read_fields(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        output: &mut [u8],
    ) -> Result<(), AccessFailure>;
    fn write(&mut self, address: u64, width: u32, value: u64) -> Result<(), AccessFailure>;
    fn write_bytes(&mut self, address: u64, bytes: &[u8]) -> Result<(), AccessFailure>;
    fn write_fields(
        &mut self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        bytes: &[u8],
    ) -> Result<(), AccessFailure>;
    fn check_read(&self, address: u64, width: u32) -> Result<(), AccessFailure>;
    fn check_write(&self, address: u64, width: u32) -> Result<(), AccessFailure>;
    /// Admit one ordinary write-intent byte without reading or publishing it.
    /// Page-walk accessed effects remain permitted; no dirty or captured write is created.
    fn probe_write(&self, address: u64) -> Result<(), AccessFailure>;
    fn read_system(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure> {
        self.read_vector(address, width)
    }
    fn check_system_write(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        self.check_write(address, width)
    }
    fn check_system_write_fields(
        &self,
        address: u64,
        width: u32,
        _fields: &[(u32, u32)],
    ) -> Result<(), AccessFailure> {
        self.check_system_write(address, width)
    }
    fn write_system(&mut self, address: u64, width: u32, value: u64) -> Result<(), AccessFailure> {
        self.write(address, width, value)
    }
    /// Publish the descriptor byte after its owner admitted the complete nominal span.
    fn publish_system_byte(
        &mut self,
        address: u64,
        _nominal_width: u32,
        offset: u32,
        byte: u8,
    ) -> Result<(), AccessFailure> {
        self.write_system(address + u64::from(offset), 1, u64::from(byte))
    }
    fn check_frame_write(&self, address: u64, width: u32, _cpl: u8) -> Result<(), AccessFailure> {
        self.check_write(address, width)
    }
    /// Admit and apply every captured dirty update before a prepared owner's publications.
    fn prepare_publication(&mut self) -> Result<(), AccessFailure> {
        Ok(())
    }
    /// Preserve the failing captured write's ordinal when the memory owner has one.
    fn prepare_publication_ordered(&mut self) -> Result<(), PublicationFailure> {
        self.prepare_publication()
            .map_err(|failure| PublicationFailure {
                index: None,
                failure,
            })
    }
}

impl GuestMemory for Image {
    fn fetch(&self, address: u64) -> Result<u8, AccessFailure> {
        Image::fetch(self, address).map_err(AccessFailure::Linear)
    }
    fn read(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        Image::read(self, address, width).map_err(AccessFailure::Linear)
    }
    fn read_for_write(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        Image::read_for_write(self, address, width).map_err(AccessFailure::Linear)
    }
    fn read_vector(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure> {
        Image::read_vector(self, address, width).map_err(AccessFailure::Linear)
    }
    fn read_fields(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        output: &mut [u8],
    ) -> Result<(), AccessFailure> {
        Image::read_fields(self, address, width, fields, output).map_err(AccessFailure::Linear)
    }
    fn write(&mut self, address: u64, width: u32, value: u64) -> Result<(), AccessFailure> {
        Image::write(self, address, width, value).map_err(AccessFailure::Linear)
    }
    fn write_bytes(&mut self, address: u64, bytes: &[u8]) -> Result<(), AccessFailure> {
        Image::write_bytes(self, address, bytes).map_err(AccessFailure::Linear)
    }
    fn write_fields(
        &mut self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        bytes: &[u8],
    ) -> Result<(), AccessFailure> {
        Image::write_fields(self, address, width, fields, bytes).map_err(AccessFailure::Linear)
    }
    fn check_read(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        Image::check_read(self, address, width).map_err(AccessFailure::Linear)
    }
    fn check_write(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        Image::check_write(self, address, width).map_err(AccessFailure::Linear)
    }
    fn probe_write(&self, address: u64) -> Result<(), AccessFailure> {
        Image::check_write(self, address, 1).map_err(AccessFailure::Linear)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{Access, Cause, Fault, MappingInput, MemoryLimits, Permissions};

    #[test]
    fn probe_write_image_is_one_write_only_byte_without_publication() {
        let mut image = Image::mapped(
            vec![("ram".into(), vec![0xa5])],
            vec![
                MappingInput {
                    base: 0x2000,
                    backing: "ram".into(),
                    offset: 0,
                    length: 1,
                    permissions: Permissions {
                        read: false,
                        write: true,
                        execute: false,
                    },
                },
                MappingInput {
                    base: 0x3000,
                    backing: "ram".into(),
                    offset: 0,
                    length: 1,
                    permissions: Permissions {
                        read: true,
                        write: false,
                        execute: true,
                    },
                },
            ],
            MemoryLimits {
                max_backing_bytes: 1,
                max_backings: 1,
                max_mappings: 2,
            },
        )
        .unwrap();
        let owner = image.register_source([(0x3000, 1)]).unwrap();
        assert!(image.activate(owner));
        assert_eq!(image.probe_write(0x2000), Ok(()));
        assert!(image.owner_valid(owner));
        assert!(!image.active_changed());
        assert_eq!(image.read(0x3000, 1), Ok(0xa5));
        for (address, cause) in [(0x2001, Cause::Unmapped), (0x3000, Cause::Permission)] {
            assert_eq!(
                image.probe_write(address),
                Err(AccessFailure::Linear(Fault {
                    address,
                    width: 1,
                    access: Access::Write,
                    cause,
                    failing: u128::from(address),
                }))
            );
        }
        assert!(image.owner_valid(owner));
    }
}

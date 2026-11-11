use super::context::AccessFailure;
use crate::memory::Image;

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
}

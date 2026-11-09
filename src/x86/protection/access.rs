use super::*;
use crate::x86::context::Mode;

#[derive(Clone, Copy)]
pub(super) struct Lookup {
    pub table: Table,
    pub base: u64,
    pub limit: u32,
    pub index: u32,
    pub selector: u16,
}

pub(super) fn ia32e(context: &ExecutionContext) -> bool {
    matches!(context.mode(), Mode::Compatibility | Mode::Long64)
}

impl Lookup {
    pub fn resolve(context: &ExecutionContext, selector: u16) -> Option<Self> {
        let (table, base, limit) = if selector & 4 == 0 {
            let root = context.gdtr();
            (Table::Gdt, root.base, u32::from(root.limit))
        } else {
            let root = context.ldtr();
            if !root.valid {
                return None;
            }
            (Table::Ldt, root.base, root.limit)
        };
        Some(Self {
            table,
            base,
            limit,
            index: u32::from(selector & 0xfff8),
            selector,
        })
    }

    pub fn fits(self, width: u32) -> bool {
        u64::from(self.index) + u64::from(width) - 1 <= u64::from(self.limit)
    }

    fn fault(
        self,
        address: u128,
        width: u32,
        access: Access,
        cause: Cause,
        failing_address: u128,
        phase: SystemPhase,
    ) -> Failure {
        Failure::SystemMemory(SystemMemoryFault {
            address,
            width,
            access,
            cause,
            failing_address,
            phase,
            table: self.table,
            selector: self.selector,
        })
    }

    fn address(
        self,
        context: &ExecutionContext,
        slice: u32,
        width: u32,
        access: Access,
        phase: SystemPhase,
    ) -> Result<u64, Failure> {
        let computed = u128::from(self.base) + u128::from(self.index) + u128::from(slice);
        let address = if ia32e(context) {
            computed
        } else {
            u128::from(computed as u32)
        };
        if address > u128::from(u64::MAX) {
            return Err(self.fault(address, width, access, Cause::AddressRange, address, phase));
        }
        if !ia32e(context) && address + u128::from(width) > 1u128 << 32 {
            return Err(self.fault(
                address,
                width,
                access,
                Cause::AddressRange,
                1u128 << 32,
                phase,
            ));
        }
        Ok(address as u64)
    }

    pub fn read(
        self,
        context: &ExecutionContext,
        image: &Image,
        slice: u32,
    ) -> Result<u64, Failure> {
        let address = self.address(context, slice, 8, Access::Read, SystemPhase::DescriptorRead)?;
        image
            .read_vector(address, 8)
            .map(|bytes| u64::from_le_bytes(bytes[..8].try_into().unwrap()))
            .map_err(|f| {
                self.fault(
                    u128::from(f.address),
                    f.width,
                    f.access,
                    f.cause,
                    f.failing,
                    SystemPhase::DescriptorRead,
                )
            })
    }

    pub fn set_accessed(
        self,
        context: &ExecutionContext,
        image: &mut Image,
        access_byte: u8,
    ) -> Result<(), Failure> {
        let address = self.address(context, 5, 1, Access::Write, SystemPhase::AccessedWrite)?;
        image
            .write(address, 1, u64::from(access_byte | 1))
            .map_err(|f| {
                self.fault(
                    u128::from(f.address),
                    f.width,
                    f.access,
                    f.cause,
                    f.failing,
                    SystemPhase::AccessedWrite,
                )
            })
    }
}

pub(super) fn read_operand(
    context: &ExecutionContext,
    image: &Image,
    offset: u64,
    width: u32,
    segment: Segment,
) -> Result<[u8; 10], Failure> {
    let address = context
        .translate(offset, width, segment, Access::Read, false)
        .map_err(Failure::Operand)?;
    let mut bytes = [0; 10];
    image
        .read_fields(address, width, &[(0, width)], &mut bytes)
        .map_err(|f| Failure::Operand(AccessFailure::Linear(f)))?;
    Ok(bytes)
}

pub(super) fn write_operand(
    context: &ExecutionContext,
    image: &mut Image,
    offset: u64,
    bytes: &[u8],
    segment: Segment,
) -> Result<(), Failure> {
    let address = context
        .translate(offset, bytes.len() as u32, segment, Access::Write, false)
        .map_err(Failure::Operand)?;
    image
        .write_bytes(address, bytes)
        .map_err(|f| Failure::Operand(AccessFailure::Linear(f)))
}

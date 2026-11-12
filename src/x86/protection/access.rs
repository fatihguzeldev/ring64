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

#[derive(Clone, Copy)]
pub(super) struct DescriptorWrite {
    lookup: Lookup,
    address: u64,
    width: u32,
    offset: u32,
    byte: u8,
    phase: SystemPhase,
}

impl DescriptorWrite {
    pub fn failure(self, failure: AccessFailure) -> Failure {
        self.lookup.access_failure(failure, self.phase)
    }

    pub fn contains(self, failure: AccessFailure) -> bool {
        let address = match failure {
            AccessFailure::Linear(failure) => failure.address,
            AccessFailure::Paging(crate::x86::paging::walk::Failure::Page(failure)) => {
                failure.address
            }
            AccessFailure::Paging(crate::x86::paging::walk::Failure::Physical(failure)) => {
                failure.linear
            }
            AccessFailure::Segment(_) => return false,
        };
        address >= self.address && address - self.address < u64::from(self.width)
    }

    pub fn commit(self, image: &mut impl GuestMemory) {
        image
            .publish_system_byte(self.address, self.width, self.offset, self.byte)
            .expect("admitted descriptor publication");
    }
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
            reference: SystemReference::Selector(self.selector),
        })
    }

    fn access_failure(self, failure: AccessFailure, phase: SystemPhase) -> Failure {
        match failure {
            AccessFailure::Linear(f) => self.fault(
                u128::from(f.address),
                f.width,
                f.access,
                f.cause,
                f.failing,
                phase,
            ),
            AccessFailure::Paging(failure) => Failure::SystemPaging(SystemPagingFault {
                failure,
                phase,
                table: self.table,
                reference: SystemReference::Selector(self.selector),
            }),
            AccessFailure::Segment(_) => unreachable!("system access has no segment admission"),
        }
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
        image: &impl GuestMemory,
        slice: u32,
    ) -> Result<u64, Failure> {
        let address = self.address(context, slice, 8, Access::Read, SystemPhase::DescriptorRead)?;
        image
            .read_system(address, 8)
            .map(|bytes| u64::from_le_bytes(bytes[..8].try_into().unwrap()))
            .map_err(|failure| self.access_failure(failure, SystemPhase::DescriptorRead))
    }

    pub fn prepare_accessed(
        self,
        context: &ExecutionContext,
        image: &impl GuestMemory,
        access_byte: u8,
    ) -> Result<DescriptorWrite, Failure> {
        let address = self.address(context, 5, 1, Access::Write, SystemPhase::AccessedWrite)?;
        image
            .check_system_write(address, 1)
            .map_err(|failure| self.access_failure(failure, SystemPhase::AccessedWrite))?;
        Ok(DescriptorWrite {
            lookup: self,
            address,
            width: 1,
            offset: 0,
            byte: access_byte | 1,
            phase: SystemPhase::AccessedWrite,
        })
    }

    pub fn prepare_busy(
        self,
        context: &ExecutionContext,
        image: &impl GuestMemory,
        width: u32,
        access_byte: u8,
    ) -> Result<DescriptorWrite, Failure> {
        let address = self.address(context, 0, width, Access::Write, SystemPhase::BusyWrite)?;
        image
            .check_system_write_fields(address, width, &[(5, 1)])
            .map_err(|failure| self.access_failure(failure, SystemPhase::BusyWrite))?;
        Ok(DescriptorWrite {
            lookup: self,
            address,
            width,
            offset: 5,
            byte: access_byte | 2,
            phase: SystemPhase::BusyWrite,
        })
    }

    pub fn set_accessed(
        self,
        context: &ExecutionContext,
        image: &mut impl GuestMemory,
        access_byte: u8,
    ) -> Result<(), Failure> {
        let address = self.address(context, 5, 1, Access::Write, SystemPhase::AccessedWrite)?;
        image
            .write_system(address, 1, u64::from(access_byte | 1))
            .map_err(|failure| self.access_failure(failure, SystemPhase::AccessedWrite))
    }
}

pub(super) fn read_operand(
    context: &ExecutionContext,
    image: &impl GuestMemory,
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
        .map_err(Failure::Operand)?;
    Ok(bytes)
}

pub(super) fn write_operand(
    context: &ExecutionContext,
    image: &mut impl GuestMemory,
    offset: u64,
    bytes: &[u8],
    segment: Segment,
) -> Result<(), Failure> {
    let address = context
        .translate(offset, bytes.len() as u32, segment, Access::Write, false)
        .map_err(Failure::Operand)?;
    image.write_bytes(address, bytes).map_err(Failure::Operand)
}

pub(super) struct SystemRead {
    pub base: u64,
    pub offset: u32,
    pub width: u32,
    pub table: Table,
    pub reference: SystemReference,
    pub phase: SystemPhase,
}

impl SystemRead {
    pub fn read(
        &self,
        context: &ExecutionContext,
        image: &impl GuestMemory,
        ext: u16,
    ) -> Result<[u8; 16], Failure> {
        let computed = u128::from(self.base) + u128::from(self.offset);
        let ia32e = ia32e(context);
        let address = if ia32e {
            computed
        } else {
            u128::from(computed as u32)
        };
        let end = address + u128::from(self.width);
        let domain = 1u128 << if ia32e { 64 } else { 32 };
        if address >= domain || end > domain {
            return Err(self.fault(address, Cause::AddressRange, address.max(domain)));
        }
        if self.table == Table::Tss
            && (!crate::memory::canonical48(address as u64)
                || !crate::memory::canonical48((end - 1) as u64))
            && ia32e
        {
            let SystemReference::Selector(selector) = self.reference else {
                unreachable!("TSS selector provenance")
            };
            return Err(Failure::Protection(ProtectionFault {
                vector: 10,
                error_code: (selector & 0xfffc) | ext,
                phase: ProtectionPhase::Descriptor,
                selector: Some(selector),
            }));
        }
        image
            .read_system(address as u64, self.width)
            .map_err(|failure| match failure {
                AccessFailure::Linear(failure) => {
                    self.fault(address, failure.cause, failure.failing)
                }
                AccessFailure::Paging(failure) => {
                    Failure::SystemPaging(crate::x86::protection::SystemPagingFault {
                        failure,
                        phase: self.phase,
                        table: self.table,
                        reference: self.reference,
                    })
                }
                AccessFailure::Segment(_) => {
                    unreachable!("system access has no segment admission")
                }
            })
    }

    fn fault(&self, address: u128, cause: Cause, failing_address: u128) -> Failure {
        Failure::SystemMemory(SystemMemoryFault {
            address,
            width: self.width,
            access: Access::Read,
            cause,
            failing_address,
            phase: self.phase,
            table: self.table,
            reference: self.reference,
        })
    }
}

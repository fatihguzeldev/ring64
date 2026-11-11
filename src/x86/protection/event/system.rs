use super::{EventFailure, ExecutionContext, GuestMemory};
use crate::memory::{Access, Cause};
use crate::x86::protection::{ProtectionFault, ProtectionPhase, SystemMemoryFault};
use crate::x86::protection::{SystemPhase, SystemReference, Table};

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
    ) -> Result<[u8; 16], EventFailure> {
        let computed = u128::from(self.base) + u128::from(self.offset);
        let ia32e = super::super::access::ia32e(context);
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
            return Err(EventFailure::Protection(ProtectionFault {
                vector: 10,
                error_code: (selector & 0xfffc) | ext,
                phase: ProtectionPhase::Descriptor,
                selector: Some(selector),
            }));
        }
        image
            .read_system(address as u64, self.width)
            .map_err(|failure| match failure {
                super::AccessFailure::Linear(failure) => {
                    self.fault(address, failure.cause, failure.failing)
                }
                super::AccessFailure::Paging(failure) => {
                    EventFailure::SystemPaging(crate::x86::protection::SystemPagingFault {
                        failure,
                        phase: self.phase,
                        table: self.table,
                        reference: self.reference,
                    })
                }
                super::AccessFailure::Segment(_) => {
                    unreachable!("system access has no segment admission")
                }
            })
    }

    fn fault(&self, address: u128, cause: Cause, failing_address: u128) -> EventFailure {
        EventFailure::SystemMemory(SystemMemoryFault {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{Access, Cause};
    use crate::x86::protection::tests::{context, image, mapping};
    use crate::x86::protection::{ProtectionFault, ProtectionPhase, SystemMemoryFault};

    #[test]
    fn tss_canonicality_is_ts_but_domain_overflow_retains_widened_private_provenance() {
        let context = context("long64", 0);
        let image = image(vec![0; 32], vec![mapping(0x1000, 0, 32, true, true)]);
        let attempt = SystemRead {
            base: 0x7fff_ffff_fffc,
            offset: 0,
            width: 8,
            table: Table::Tss,
            reference: SystemReference::Selector(0x28),
            phase: SystemPhase::TssRead,
        };
        assert_eq!(
            attempt.read(&context, &image, 1),
            Err(EventFailure::Protection(ProtectionFault {
                vector: 10,
                error_code: 0x29,
                phase: ProtectionPhase::Descriptor,
                selector: Some(0x28)
            }))
        );
        let attempt = SystemRead {
            base: u64::MAX - 7,
            offset: 8,
            width: 8,
            ..attempt
        };
        assert_eq!(
            attempt.read(&context, &image, 1),
            Err(EventFailure::SystemMemory(SystemMemoryFault {
                address: 1u128 << 64,
                width: 8,
                access: Access::Read,
                cause: Cause::AddressRange,
                failing_address: 1u128 << 64,
                phase: SystemPhase::TssRead,
                table: Table::Tss,
                reference: SystemReference::Selector(0x28)
            }))
        );
    }

    #[test]
    fn vector_lookup_preserves_vector_identity_and_complete_endpoint() {
        let context = context("long64", 0);
        let image = image(vec![0; 32], vec![mapping(0x1000, 0, 32, true, true)]);
        let attempt = SystemRead {
            base: u64::MAX - 7,
            offset: 0,
            width: 16,
            table: Table::Idt,
            reference: SystemReference::Vector(0x80),
            phase: SystemPhase::GateRead,
        };
        assert_eq!(
            attempt.read(&context, &image, 0),
            Err(EventFailure::SystemMemory(SystemMemoryFault {
                address: u128::from(u64::MAX - 7),
                width: 16,
                access: Access::Read,
                cause: Cause::AddressRange,
                failing_address: 1u128 << 64,
                phase: SystemPhase::GateRead,
                table: Table::Idt,
                reference: SystemReference::Vector(0x80)
            }))
        );
    }

    #[test]
    fn legacy_system_start_wraps_32_but_complete_field_must_not_wrap() {
        let context = context("protected", 0);
        let image = image(
            vec![1, 2, 3, 4, 5, 6, 7, 8],
            vec![mapping(0x10, 0, 8, true, false)],
        );
        let attempt = SystemRead {
            base: 0xffff_fff0,
            offset: 0x20,
            width: 8,
            table: Table::Idt,
            reference: SystemReference::Vector(4),
            phase: SystemPhase::GateRead,
        };
        assert_eq!(
            &attempt.read(&context, &image, 0).unwrap()[..8],
            &[1, 2, 3, 4, 5, 6, 7, 8]
        );
        let attempt = SystemRead {
            base: 0xffff_fffc,
            offset: 0,
            ..attempt
        };
        assert!(matches!(
            attempt.read(&context, &image, 0),
            Err(EventFailure::SystemMemory(SystemMemoryFault {
                address: 0xffff_fffc,
                width: 8,
                cause: Cause::AddressRange,
                failing_address: 0x1_0000_0000,
                ..
            }))
        ));
    }
}

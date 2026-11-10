use super::*;
use crate::x86::context::SegmentCause;

fn runtime(vector: u8) -> ProtectionFault {
    ProtectionFault {
        vector,
        error_code: 0,
        phase: ProtectionPhase::Target,
        selector: None,
    }
}

/// Classify an already detected access failure, with its effective architectural segment.
pub fn access_fault(
    context: &ExecutionContext,
    segment: Segment,
    failure: AccessFailure,
) -> Option<ProtectionFault> {
    let vector = match failure {
        AccessFailure::Linear(fault)
            if context.is_long64() && fault.cause == Cause::Noncanonical =>
        {
            if segment == Segment::Ss { 12 } else { 13 }
        }
        AccessFailure::Segment(fault) if !context.is_long64() => match fault.cause {
            SegmentCause::Limit => {
                if segment == Segment::Ss {
                    12
                } else {
                    13
                }
            }
            SegmentCause::Unusable
                if matches!(context.mode(), Mode::Protected | Mode::Compatibility)
                    && matches!(
                        segment,
                        Segment::Ds | Segment::Es | Segment::Fs | Segment::Gs
                    )
                    && context.selector(segment) & !3 == 0 =>
            {
                13
            }
            SegmentCause::Type
                if matches!(context.mode(), Mode::Protected | Mode::Compatibility)
                    && segment != Segment::Ss =>
            {
                13
            }
            _ => return None,
        },
        _ => return None,
    };
    Some(runtime(vector))
}

pub fn alignment_fault() -> ProtectionFault {
    runtime(13)
}

pub fn system_fault(
    context: &ExecutionContext,
    fault: SystemMemoryFault,
) -> Option<ProtectionFault> {
    (matches!(context.mode(), Mode::Compatibility | Mode::Long64)
        && fault.cause == Cause::Noncanonical
        && matches!(fault.table, Table::Gdt | Table::Ldt | Table::Idt))
    .then(|| runtime(13))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::Fault;
    use crate::x86::protection::tests::context;

    #[test]
    fn effective_segment_selects_canonical_fault_but_private_domain_refusals_stay_private() {
        let long = context("long64", 0);
        for (segment, vector) in [
            (Segment::Ss, 12),
            (Segment::Ds, 13),
            (Segment::Fs, 13),
            (Segment::Cs, 13),
        ] {
            let fault = Fault {
                address: 0x8000_0000_0000,
                width: 8,
                access: Access::Read,
                cause: Cause::Noncanonical,
                failing: 0x8000_0000_0000,
            };
            let selected = access_fault(&long, segment, AccessFailure::Linear(fault)).unwrap();
            assert_eq!((selected.vector, selected.error_code), (vector, 0));
            for cause in [Cause::Unmapped, Cause::Permission, Cause::AddressRange] {
                assert_eq!(
                    access_fault(
                        &long,
                        segment,
                        AccessFailure::Linear(Fault { cause, ..fault })
                    ),
                    None
                );
            }
        }
    }

    #[test]
    fn segment_failures_distinguish_runtime_limits_types_and_artificial_caches() {
        for mode in [
            "real",
            "virtual8086",
            "protected",
            "compatibility",
            "long64",
        ] {
            let context = context(mode, if mode == "virtual8086" { 3 } else { 0 });
            for segment in Segment::ALL {
                let limit = crate::x86::context::SegmentFault {
                    segment,
                    offset: 0x10000,
                    width: 4,
                    access: Access::Read,
                    cause: SegmentCause::Limit,
                    failing: 0x10000,
                };
                assert_eq!(
                    access_fault(&context, segment, AccessFailure::Segment(limit))
                        .map(|f| (f.vector, f.error_code)),
                    (mode != "long64").then_some((if segment == Segment::Ss { 12 } else { 13 }, 0))
                );
                let unusable = AccessFailure::Segment(crate::x86::context::SegmentFault {
                    cause: SegmentCause::Unusable,
                    ..limit
                });
                // These imported caches are not proof that a null selector was loaded.
                if context.selector(segment) & !3 != 0 || segment == Segment::Ss || mode == "long64"
                {
                    assert_eq!(access_fault(&context, segment, unusable), None);
                }
            }
        }
    }

    #[test]
    fn table_canonicality_does_not_erase_tss_or_widened_domain_rules() {
        let context = context("long64", 0);
        let fault = SystemMemoryFault {
            address: 0x8000_0000_0000,
            width: 8,
            access: Access::Read,
            cause: Cause::Noncanonical,
            failing_address: 0x8000_0000_0000,
            phase: SystemPhase::DescriptorRead,
            table: Table::Gdt,
            reference: SystemReference::Selector(4),
        };
        for table in [Table::Gdt, Table::Ldt, Table::Idt] {
            let selected = system_fault(&context, SystemMemoryFault { table, ..fault }).unwrap();
            assert_eq!((selected.vector, selected.error_code), (13, 0));
        }
        assert_eq!(
            system_fault(
                &context,
                SystemMemoryFault {
                    table: Table::Tss,
                    ..fault
                }
            ),
            None
        );
        assert_eq!(
            system_fault(
                &context,
                SystemMemoryFault {
                    cause: Cause::AddressRange,
                    ..fault
                }
            ),
            None
        );
        assert_eq!(
            (alignment_fault().vector, alignment_fault().error_code),
            (13, 0)
        );
    }
}

use super::*;

fn denied() -> Failure {
    Failure::Protection(ProtectionFault {
        vector: 13,
        error_code: 0,
        phase: ProtectionPhase::Privilege,
        selector: None,
    })
}

fn word(
    context: &ExecutionContext,
    memory: &impl GuestMemory,
    offset: u32,
) -> Result<u16, Failure> {
    let tr = context.tr();
    let wide = access::ia32e(context);
    let formed = u128::from(tr.base) + u128::from(offset);
    let address = if wide {
        formed
    } else {
        u128::from(formed as u32)
    };
    let domain = 1u128 << if wide { 64 } else { 32 };
    let system = |cause, failing_address| {
        Failure::SystemMemory(SystemMemoryFault {
            address,
            width: 2,
            access: Access::Read,
            cause,
            failing_address,
            phase: SystemPhase::TssRead,
            table: Table::Tss,
            reference: SystemReference::Selector(tr.selector),
        })
    };
    if address + 2 > domain {
        return Err(system(Cause::AddressRange, address.max(domain)));
    }
    if wide
        && (!crate::memory::canonical48(address as u64)
            || !crate::memory::canonical48((address + 1) as u64))
    {
        return Err(denied());
    }
    let bytes = memory
        .read_system(address as u64, 2)
        .map_err(|failure| match failure {
            AccessFailure::Linear(f) => system(f.cause, f.failing),
            AccessFailure::Paging(failure) => Failure::SystemPaging(SystemPagingFault {
                failure,
                phase: SystemPhase::TssRead,
                table: Table::Tss,
                reference: SystemReference::Selector(tr.selector),
            }),
            AccessFailure::Segment(_) => unreachable!("implicit TSS access"),
        })?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

pub fn admit(
    context: &ExecutionContext,
    memory: &impl GuestMemory,
    flags: u64,
    port: u16,
    width: Width,
) -> Result<(), Failure> {
    assert!(matches!(width, Width::W8 | Width::W16 | Width::W32));
    if context.mode() == Mode::Real
        || context.mode() != Mode::Virtual8086 && u64::from(context.cpl()) <= (flags >> 12) & 3
    {
        return Ok(());
    }
    let tr = context.tr();
    if !tr.valid
        || tr.selector & !3 == 0
        || tr.selector & 4 != 0
        || tr.attributes & 0x9f != 0x8b
        || tr.limit < 0x67
    {
        return Err(denied());
    }
    let base = u32::from(word(context, memory, 0x66)?);
    let offset = base + u32::from(port >> 3);
    if base >= tr.limit || offset + 1 > tr.limit {
        return Err(denied());
    }
    let permissions = word(context, memory, offset)?;
    let mask = ((1u16 << width.bytes()) - 1) << (port & 7);
    if permissions & mask != 0 {
        Err(denied())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::x86::context::TaskRegister;
    use crate::x86::protection::tests::{context, image, mapping};

    fn tss(mode: &str, limit: u32) -> ExecutionContext {
        let mut context = context(mode, 3);
        context.set_tr(TaskRegister {
            selector: 0x28,
            valid: true,
            base: 0x8000,
            limit,
            attributes: 0x8b,
        });
        context
    }
    fn bytes(permission: u16, length: usize) -> Image {
        let mut bytes = vec![0; length];
        bytes[0x66..0x68].copy_from_slice(&0x80u16.to_le_bytes());
        bytes[0x80] = permission as u8;
        if length > 0x81 {
            bytes[0x81] = (permission >> 8) as u8;
        }
        image(bytes, vec![mapping(0x8000, 0, length as u32, true, true)])
    }
    #[test]
    fn bypass_has_no_task_reads_but_vm_requires_bitmap_even_at_iopl_three() {
        let empty = image(vec![0], vec![]);
        for mode in ["real", "protected", "compatibility", "long64"] {
            let cpl = if mode == "real" { 0 } else { 3 };
            assert_eq!(
                admit(&context(mode, cpl), &empty, 0x3002, 0xffff, Width::W32),
                Ok(())
            );
        }
        assert_eq!(
            admit(&context("virtual8086", 3), &empty, 0x3002, 0, Width::W8),
            Err(denied())
        );
        assert_eq!(
            admit(&context("long64", 0), &empty, 2, 0, Width::W8),
            Ok(())
        );
    }
    #[test]
    fn selected_bits_and_live_two_byte_word_determine_permission() {
        let ctx = tss("protected", 0x81);
        for width in [Width::W8, Width::W16, Width::W32] {
            let mask = match width {
                Width::W8 => 0x80,
                Width::W16 => 0x180,
                _ => 0x780,
            };
            for bit in 0..16 {
                let memory = bytes(1 << bit, 0x82);
                assert_eq!(
                    admit(&ctx, &memory, 2, 7, width),
                    if mask & (1 << bit) != 0 {
                        Err(denied())
                    } else {
                        Ok(())
                    }
                );
            }
        }
        let mut memory = bytes(0, 0x82);
        assert_eq!(admit(&ctx, &memory, 2, 7, Width::W8), Ok(()));
        memory.write(0x8080, 1, 0x80).unwrap();
        assert_eq!(admit(&ctx, &memory, 2, 7, Width::W8), Err(denied()));
    }
    #[test]
    fn complete_permission_word_access_precedes_deny_and_limits_precede_reads() {
        let memory = bytes(1, 0x81);
        let fault = admit(&tss("protected", 0x81), &memory, 2, 0, Width::W8).unwrap_err();
        assert!(matches!(
            fault,
            Failure::SystemMemory(SystemMemoryFault {
                address: 0x8080,
                width: 2,
                failing_address: 0x8081,
                table: Table::Tss,
                phase: SystemPhase::TssRead,
                reference: SystemReference::Selector(0x28),
                ..
            })
        ));
        assert_eq!(
            admit(&tss("protected", 0x80), &memory, 2, 0, Width::W8),
            Err(denied())
        );
        assert_eq!(
            admit(
                &tss("protected", 0x66),
                &image(vec![0], vec![]),
                2,
                0,
                Width::W8
            ),
            Err(denied())
        );
    }
    #[test]
    fn malformed_task_and_noncanonical_span_select_gp_without_event_task_fault() {
        let memory = bytes(0, 0x82);
        for attributes in [0x83, 0x89, 0x0b, 0x9b] {
            let mut ctx = tss("long64", 0x81);
            let mut tr = ctx.tr();
            tr.attributes = attributes;
            ctx.set_tr(tr);
            assert_eq!(admit(&ctx, &memory, 2, 0, Width::W8), Err(denied()));
        }
        let mut ctx = tss("long64", 0x81);
        let mut tr = ctx.tr();
        tr.base = 0x8000_0000_0000;
        ctx.set_tr(tr);
        assert_eq!(admit(&ctx, &memory, 2, 0, Width::W8), Err(denied()));
    }
}

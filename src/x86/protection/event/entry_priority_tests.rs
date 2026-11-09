use super::*;
use crate::x86::context::{TableRegister, TaskRegister};
use crate::x86::protection::tests::{context, image, mapping};

#[test]
fn tss_new_ss_rpl_is_checked_before_an_unmapped_stack_descriptor() {
    let mut context = context("protected", 3);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 23,
    });
    context.set_idtr(TableRegister {
        base: 0x2000,
        limit: 31,
    });
    context.set_tr(TaskRegister {
        selector: 0x28,
        valid: true,
        base: 0x3000,
        limit: 0x67,
        attributes: 0x8b,
    });
    let before = context.clone();
    let mut data = vec![0xa5; 80];
    data[8..16].copy_from_slice(&0x00cf_9a00_0000_ffffu64.to_le_bytes());
    data[56..64].copy_from_slice(&0x0000_ee00_0008_3456u64.to_le_bytes());
    data[68..72].copy_from_slice(&0x4000u32.to_le_bytes());
    data[72..74].copy_from_slice(&0x13u16.to_le_bytes());
    let mut image = image(
        data,
        vec![
            mapping(0x1000, 0, 16, true, true),
            mapping(0x2000, 32, 32, true, false),
            mapping(0x3000, 64, 16, true, false),
        ],
    );
    assert_eq!(
        execute(
            &mut context,
            &mut image,
            SoftwareEventDescriptor {
                kind: SoftwareEventKind::Int3,
                width: Width::W16,
                vector: 3
            },
            EventInputs {
                flags: 2,
                sp: 0x5000,
                next_pc: 0x2200
            }
        ),
        Err(EventFailure::Protection(ProtectionFault {
            vector: 10,
            error_code: 0x10,
            phase: ProtectionPhase::Selector,
            selector: Some(0x13)
        }))
    );
    assert_eq!(context, before);
    assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], 0x9a);
}

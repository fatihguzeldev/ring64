use super::*;
use crate::embedding::layout::PAGE_FAULT;
use crate::memory::{MappingInput, MemoryLimits, Permissions};
use crate::x86::access::GuestMemory;
use crate::x86::context::{Mode, TableRegister, TaskRegister};
use crate::x86::instruction::{FarDescriptor, FarKind, Width};
use crate::x86::paging::{State, access::Memory};

#[test]
fn failed_gate_drops_earlier_frame_captures_before_returning_to_the_host() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let mut bytes = vec![0xa5; 0x12000];
        bytes[0x10000..0x12000].fill(0);
        for (at, value, width) in [
            (0x3008, 0x00cf_9b00_0000_ffff_u64, 8),
            (0x3010, 0x00cf_9300_0000_ffff, 8),
            (0x4004, 0x9008, 4),
            (0x4008, 0x10, 2),
            (0x10000, 0x11027, 4),
            (0x1100c, 0x3063, 4),
            (0x11010, 0x4063, 4),
            (0x11024, 0x9023, 4),
        ] {
            bytes[at..at + width].copy_from_slice(&value.to_le_bytes()[..width]);
        }
        bytes[0x3038..0x3040].copy_from_slice(&[0, 0x20, 8, 0, 0, 0xec, 0, 0]);
        core.image = Image::physical_mapped(
            vec![("ram".into(), bytes)],
            vec![MappingInput {
                base: 0,
                offset: 0,
                length: 0x12000,
                backing: "ram".into(),
                permissions: Permissions {
                    read: true,
                    write: true,
                    execute: true,
                },
            }],
            MemoryLimits {
                max_backing_bytes: 0x12000,
                max_backings: 1,
                max_mappings: 1,
            },
        )
        .unwrap();
        core.paging = Some(State {
            cr0: 0x8001_0033,
            cr3: 0x10000,
            cr4: 0x608,
            efer: 0,
            ..State::default()
        });
        core.context.set_mode_and_cpl(Mode::Protected, 3);
        for (segment, selector) in [(Segment::Cs, 0x1b), (Segment::Ss, 0x23)] {
            let mut attributes = core.context.attributes(segment);
            attributes.dpl = 3;
            attributes.long = false;
            core.context
                .set_segment(segment, selector, core.context.segment(segment), attributes);
        }
        core.context.set_gdtr(TableRegister {
            base: 0x3000,
            limit: 0x7f,
        });
        core.context.set_tr(TaskRegister {
            selector: 0x28,
            valid: true,
            base: 0x4000,
            limit: 0x67,
            attributes: 0x8b,
        });
    });
    let call = FarDescriptor {
        kind: FarKind::Call,
        width: Width::W32,
        memory: false,
    }
    .encode();
    assert_eq!(
        far_control::core_paged_far_control(
            call,
            0xffff_ffff,
            0x3b,
            0x5000,
            0x1007,
            Segment::Ds as u32
        ),
        PAGE_FAULT
    );
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        assert_eq!(core.image.physical_read(0x11024, 4).unwrap(), 0x9023);
        // The first two frame writes were admitted before the third slot faulted.
        // A later owner must not publish their abandoned dirty updates.
        let paging = core.paging.unwrap();
        Memory::new(&mut core.image, &paging, 3, &mut core.paging_work)
            .prepare_publication()
            .unwrap();
        assert_eq!(
            core.image.physical_read(0x11024, 4).unwrap(),
            0x9023,
            "failed gate retained frame captures across its private return"
        );
        assert_eq!(
            core.image.physical_read_bytes(0x9000, 8).unwrap(),
            vec![0xa5; 8]
        );
    });
}

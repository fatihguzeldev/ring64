use super::*;
use crate::memory::{Cause, MappingInput, MemoryLimits, Permissions};
use crate::x86::context::TableRegister;
use crate::x86::paging::{
    State,
    access::{AccessState, Memory},
    walk::{self, PhysicalPhase},
};

fn put(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn frame_dirty_failure_after_a_remap_is_not_an_earlier_descriptor_write() {
    let (mut context, _) = gate_tests::fixture("protected");
    context.set_gdtr(TableRegister {
        base: 0xff0,
        limit: 0x3fff,
    });
    let mut bytes = vec![0xa5; 0x20000];
    // PDE byte1 aliases PTE1's low byte. Its ignored software bits make
    // that byte53 (P1/RW1/A0/D1 as a PTE), so setting A redirects55xxx to57xxx.
    put(&mut bytes, 0x4000, 0x55323);
    put(&mut bytes, 0x5000, 0xb063);
    put(&mut bytes, 0x5004, 0xa053);
    put(&mut bytes, 0x5008, 0xc063);
    put(&mut bytes, 0x500c, 0xd063);
    put(&mut bytes, 0x7000, 0xe023);
    put(&mut bytes, 0x7004, 0xa063);
    bytes[0xbff8..0xc000].copy_from_slice(&0x00cf_9a00_0000_ffff_u64.to_le_bytes());
    bytes[0xcff0..0xcff8].copy_from_slice(&[0x00, 0x20, 8, 0, 0, 0xec, 0, 0]);
    bytes[0xdff0..0xdff8].copy_from_slice(&0x00cf_9200_0000_ffff_u64.to_le_bytes());
    put(&mut bytes, 0xc004, 0x1009);
    bytes[0xc008..0xc00a].copy_from_slice(&0x3000_u16.to_le_bytes());
    let mapping = |base, offset, length, write| MappingInput {
        base,
        offset,
        length,
        backing: "ram".into(),
        permissions: Permissions {
            read: true,
            write,
            execute: true,
        },
    };
    let mut image = Image::physical_mapped(
        vec![("ram".into(), bytes)],
        vec![
            mapping(0, 0, 0x20000, true),
            mapping(0x55000, 0x5000, 4, true),
            mapping(0x55004, 0x4001, 1, true),
            mapping(0x55005, 0x5005, 0xffb, true),
            mapping(0x57000, 0x7000, 0x1000, false),
        ],
        MemoryLimits {
            max_backing_bytes: 0x20000,
            max_backings: 1,
            max_mappings: 5,
        },
    )
    .unwrap();
    let state = State {
        cr0: 0x8001_0033,
        cr3: 0x4000,
        cr4: 0x608,
        efer: 0,
        ..State::default()
    };
    let before_context = context.clone();
    let before_frame = image.physical_read_bytes(0xeff9, 10).unwrap();
    let mut work = AccessState::default();
    let result = execute(
        &mut context,
        &mut Memory::new(&mut image, &state, 3, 2, &mut work),
        FarDescriptor {
            kind: FarKind::Call,
            width: Width::W32,
            memory: false,
        },
        FarOperands {
            offset: 0xffff,
            selector: 0x2003,
            input_sp: 0x4000,
            next_pc: 0x1007,
            segment: Segment::Ds,
        },
    );
    // The first frame walk really changed subsequent page-table authority.
    assert_eq!(image.physical_read(0x4000, 4).unwrap(), 0x57323);
    assert_eq!(image.physical_read(0x55004, 4).unwrap(), 0xa073);
    assert!(
        matches!(
            result,
            Err(FarFailure::Operand {
                segment: Segment::Ss,
                failure: AccessFailure::Paging(walk::Failure::Physical(walk::PhysicalFault {
                    linear: 0xffd,
                    access: Access::Write,
                    phase: PhysicalPhase::DirtyWrite,
                    physical: crate::memory::Fault {
                        address: 0x57000,
                        width: 4,
                        cause: Cause::Permission,
                        ..
                    },
                })),
            })
        ),
        "frame D refusal must retain its own captured operand identity: {result:?}"
    );
    assert_eq!(context, before_context);
    assert_eq!(image.physical_read(0x57000, 4).unwrap(), 0xe023);
    assert_eq!(image.physical_read(0xbffd, 1).unwrap(), 0x9a);
    assert_eq!(image.physical_read(0xdff5, 1).unwrap(), 0x92);
    assert_eq!(image.physical_read_bytes(0xeff9, 10).unwrap(), before_frame);
    assert_eq!(image.physical_read_bytes(0xa000, 9).unwrap(), vec![0xa5; 9]);
}

#[test]
fn ordinary_call_frame_dirty_refusal_keeps_its_own_prepared_origin() {
    let (mut context, _) = gate_tests::fixture("protected");
    context.set_gdtr(TableRegister {
        base: 0xff0,
        limit: 0x3fff,
    });
    let mut bytes = vec![0xa5; 0x20000];
    put(&mut bytes, 0x4000, 0x55727);
    put(&mut bytes, 0x5000, 0xb067);
    put(&mut bytes, 0x5004, 0xa057);
    put(&mut bytes, 0x7000, 0xe027);
    put(&mut bytes, 0x7004, 0xa067);
    bytes[0xbff8..0xc000].copy_from_slice(&0x00cf_fa00_0000_ffff_u64.to_le_bytes());
    let mapping = |base, offset, length, write| MappingInput {
        base,
        offset,
        length,
        backing: "ram".into(),
        permissions: Permissions {
            read: true,
            write,
            execute: true,
        },
    };
    let mut image = Image::physical_mapped(
        vec![("ram".into(), bytes)],
        vec![
            mapping(0, 0, 0x20000, true),
            mapping(0x55000, 0x5000, 4, true),
            mapping(0x55004, 0x4001, 1, true),
            mapping(0x55005, 0x5005, 0xffb, true),
            mapping(0x57000, 0x7000, 0x1000, false),
        ],
        MemoryLimits {
            max_backing_bytes: 0x20000,
            max_backings: 1,
            max_mappings: 5,
        },
    )
    .unwrap();
    let state = State {
        cr0: 0x8001_0033,
        cr3: 0x4000,
        cr4: 0x608,
        efer: 0,
        ..State::default()
    };
    let before = context.clone();
    let mut work = AccessState::default();
    let result = execute(
        &mut context,
        &mut Memory::new(&mut image, &state, 3, 2, &mut work),
        FarDescriptor {
            kind: FarKind::Call,
            width: Width::W32,
            memory: false,
        },
        FarOperands {
            offset: 0x2000,
            selector: 0x0b,
            input_sp: 0x1005,
            next_pc: 0x1007,
            segment: Segment::Ds,
        },
    );
    assert_eq!(image.physical_read(0x4000, 4).unwrap(), 0x57727);
    assert_eq!(image.physical_read(0x55004, 4).unwrap(), 0xa077);
    assert!(
        matches!(
            result,
            Err(FarFailure::Operand {
                segment: Segment::Ss,
                failure: AccessFailure::Paging(walk::Failure::Physical(walk::PhysicalFault {
                    linear: 0xffd,
                    access: Access::Write,
                    phase: PhysicalPhase::DirtyWrite,
                    physical: crate::memory::Fault {
                        address: 0x57000,
                        width: 4,
                        cause: Cause::Permission,
                        ..
                    },
                })),
            })
        ),
        "ordinary frame D refusal must retain its own prepared origin: {result:?}"
    );
    assert_eq!(context, before);
    assert_eq!(image.physical_read(0x57000, 4).unwrap(), 0xe027);
    assert_eq!(image.physical_read(0xbffd, 1).unwrap(), 0xfa);
    assert_eq!(image.physical_read_bytes(0xeffd, 4).unwrap(), vec![0xa5; 4]);
    assert_eq!(image.physical_read_bytes(0xa001, 4).unwrap(), vec![0xa5; 4]);
}

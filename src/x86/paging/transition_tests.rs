use super::*;
use crate::memory::{Access, Image, MappingInput, MemoryLimits, Permissions};
use crate::x86::context::Mode;

fn unpaged() -> State {
    State {
        cr0: 0x60000010,
        cr2: 0xfedcba9876543210,
        cr3: 0x0008000000003018,
        cr4: 0,
        efer: 0,
        pdpte: None,
    }
}

#[test]
fn physical_unpaged_controls_admit_real_and_protected_without_weakening_ia32e() {
    let state = unpaged();
    assert_eq!(state.validate_physical(Mode::Real), Ok(()));
    assert!(state.validate().is_err());
    let protected = state
        .prepare_physical_cr_write(0, 0x33, Mode::Real)
        .unwrap();
    assert_eq!(protected.validate_physical(Mode::Protected), Ok(()));
    assert!(protected.validate_physical(Mode::Real).is_err());
    let enabled = protected
        .prepare_physical_cr_write(0, 0x80000033, Mode::Protected)
        .unwrap();
    let real = enabled
        .prepare_physical_cr_write(0, 0x32, Mode::Protected)
        .unwrap();
    assert_eq!(real.validate_physical(Mode::Real), Ok(()));
    assert_eq!(real.cr3, state.cr3);
    assert_eq!(real.cr2, state.cr2);
    assert!(
        state
            .prepare_physical_cr_write(0, 0x80000010, Mode::Real)
            .is_err()
    );
    assert!(
        state
            .prepare_physical_cr_write(0, 0x20000010, Mode::Real)
            .is_err()
    );
}

#[test]
fn unpaged_walk_is_identity_without_table_reads_dirty_metadata_or_zero_remaining() {
    let mut image = Image::physical_mapped(
        vec![("ram".into(), vec![0x42; 16])],
        vec![MappingInput {
            base: 0,
            backing: "ram".into(),
            offset: 0,
            length: 16,
            permissions: Permissions {
                read: true,
                write: true,
                execute: true,
            },
        }],
        MemoryLimits {
            max_backings: 1,
            max_mappings: 1,
            max_backing_bytes: 16,
        },
    )
    .unwrap();
    for access in [Access::Read, Access::Write, Access::Execute] {
        let translation = walk::walk(
            &mut image,
            &unpaged(),
            walk::Request {
                linear: 0,
                access,
                user: true,
            },
        )
        .unwrap();
        assert_eq!(translation.physical, 0);
        assert!(translation.entries().is_empty());
        assert!(!translation.dirty);
        assert_eq!(translation.entry_width, 0);
        assert_eq!(translation.remaining, 1u64 << 32);
    }
}

#[test]
fn unpaged_prepared_access_at_zero_has_no_fake_leaf_or_dirty_work() {
    use crate::x86::access::GuestMemory;
    let mut image = Image::physical_mapped(
        vec![("ram".into(), vec![0; 16])],
        vec![MappingInput {
            base: 0,
            backing: "ram".into(),
            offset: 0,
            length: 16,
            permissions: Permissions {
                read: true,
                write: true,
                execute: false,
            },
        }],
        MemoryLimits {
            max_backings: 1,
            max_mappings: 1,
            max_backing_bytes: 16,
        },
    )
    .unwrap();
    let mut work = access::AccessState::default();
    access::Memory::new(&mut image, &unpaged(), 3, &mut work)
        .write(0, 8, 0x1122334455667788)
        .unwrap();
    assert_eq!(image.physical_read(0, 8).unwrap(), 0x1122334455667788);
    assert_eq!(
        access::Memory::new(&mut image, &unpaged(), 3, &mut work)
            .read(0, 8)
            .unwrap(),
        0x1122334455667788
    );
}

#[test]
fn reset_context_literals_and_physical_snapshot_keep_transitional_loaded_caches() {
    use crate::x86::context::{ExecutionContext, Segment};
    let context = ExecutionContext::reset();
    assert_eq!(context.mode(), Mode::Real);
    assert_eq!(context.selector(Segment::Cs), 0xf000);
    assert_eq!(context.segment(Segment::Cs).base, 0xffff0000);
    assert_eq!(context.segment(Segment::Cs).limit, 0xffff);
    assert!(!context.code32());
    assert_eq!(context.gdtr().limit, 0xffff);
    let candidate = unpaged()
        .prepare_physical_cr_write(0, 0x33, Mode::Real)
        .unwrap();
    let protected = unpaged().transition_context(candidate, &context).unwrap();
    assert_eq!(protected.segment(Segment::Cs), context.segment(Segment::Cs));
    assert_eq!(protected.mode(), Mode::Protected);
    let snapshot = protected.to_json();
    assert!(ExecutionContext::from_json(&snapshot).is_err());
    assert_eq!(
        ExecutionContext::from_json_profile(&snapshot, true).unwrap(),
        protected
    );
    assert_eq!(candidate.validate_physical_context(&protected), Ok(()));
}

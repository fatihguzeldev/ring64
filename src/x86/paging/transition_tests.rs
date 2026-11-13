use super::*;
use crate::memory::{Access, Image, MappingInput, MemoryLimits, Permissions};
use crate::x86::context::{Mode, Segment};

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
                class: walk::AccessClass::User,
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
    access::Memory::new(&mut image, &unpaged(), 3, 0, &mut work)
        .write(0, 8, 0x1122334455667788)
        .unwrap();
    assert_eq!(image.physical_read(0, 8).unwrap(), 0x1122334455667788);
    assert_eq!(
        access::Memory::new(&mut image, &unpaged(), 3, 0, &mut work)
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

#[test]
fn physical_transition_matrix_has_literal_control_failures_and_retains_raw_banks() {
    use ControlFailure::{GeneralProtection as Gp, Unsupported};
    let pg0 = State {
        cr0: 0x33,
        cr4: 0x608,
        ..unpaged()
    };
    for (register, value, want) in [
        (0, 0x80000032, Gp),
        (0, 0x20000033, Gp),
        (0, 1 << 32 | 0x33, Gp),
        (0, 0x40033, Unsupported),
        (4, 1 << 15, Gp),
        (4, 1 << 17, Gp),
        (4, 1 << 23, Gp),
        (4, 1 << 7, Unsupported),
        (4, 1 << 12, Unsupported),
        (8, 16, Gp),
        (8, 0, Unsupported),
    ] {
        assert_eq!(
            pg0.prepare_physical_cr_write(register, value, Mode::Protected),
            Err(want),
            "CR{register}={value:x}"
        );
    }
    for cache in [0, 0x40000000, 0x60000000] {
        let result = pg0
            .prepare_physical_cr_write(0, cache | 0x33, Mode::Protected)
            .unwrap();
        assert_eq!(result.cr0, cache | 0x33);
        assert_eq!(
            (result.cr2, result.cr3),
            (0xfedcba9876543210, 0x0008000000003018)
        );
    }
    let armed = pg0.prepare_physical_efer_write(0xd01).unwrap();
    assert_eq!(armed.efer, 0x901, "LMA input ignored");
    assert_eq!(
        armed.prepare_physical_cr_write(0, 0x80000033, Mode::Protected),
        Err(Gp),
        "LME requires PAE on PG activation"
    );
    let pae = armed
        .prepare_physical_cr_write(4, 0x628, Mode::Protected)
        .unwrap();
    let active = pae
        .prepare_physical_cr_write(0, 0x80000033, Mode::Protected)
        .unwrap();
    assert_eq!(active.efer, 0xd01);
    assert_eq!(
        active.prepare_physical_efer_write(0x801),
        Err(Gp),
        "cannot change LME with PG"
    );
    assert_eq!(
        active.prepare_physical_cr_write(4, 0x608, Mode::Compatibility),
        Err(Gp),
        "LMA requires PAE"
    );
    assert_eq!(
        active.prepare_physical_cr_write(0, 0x33, Mode::Long64),
        Err(Gp),
        "leave Long64 first"
    );
    let exited = active
        .prepare_physical_cr_write(0, 0x32, Mode::Compatibility)
        .unwrap();
    assert_eq!(exited.efer, 0x901);
    assert_eq!(exited.cr3, pg0.cr3);
    assert_eq!(
        exited.prepare_physical_efer_write(0xc01).unwrap().efer,
        0x801
    );
}

#[test]
fn activation_checks_loaded_cs_and_16bit_task_before_publishing_mode_or_tables() {
    use crate::x86::context::{ExecutionContext, TaskRegister};
    let old = State {
        cr0: 0x33,
        cr4: 0x628,
        efer: 0x100,
        ..State::reset()
    };
    let candidate = old
        .prepare_physical_cr_write(0, 0x80000033, Mode::Protected)
        .unwrap();
    let mut context = ExecutionContext::reset();
    context.set_mode_and_cpl(Mode::Protected, 0);
    for task in [1, 3] {
        context.set_tr(TaskRegister {
            selector: 0x28,
            valid: true,
            base: 0,
            limit: 0x67,
            attributes: task,
        });
        assert_eq!(
            old.transition_context(candidate, &context),
            Err(ControlFailure::GeneralProtection)
        );
    }
    context.set_tr(TaskRegister {
        valid: false,
        ..context.tr()
    });
    let mut attributes = context.attributes(Segment::Cs);
    attributes.long = true;
    context.set_segment(
        Segment::Cs,
        context.selector(Segment::Cs),
        context.segment(Segment::Cs),
        attributes,
    );
    assert_eq!(
        old.transition_context(candidate, &context),
        Err(ControlFailure::GeneralProtection)
    );
    attributes.long = false;
    context.set_segment(
        Segment::Cs,
        context.selector(Segment::Cs),
        context.segment(Segment::Cs),
        attributes,
    );
    let compat = old.transition_context(candidate, &context).unwrap();
    assert_eq!(compat.mode(), Mode::Compatibility);
    assert_eq!(compat.segment(Segment::Cs).base, 0xffff0000);
    assert_eq!(candidate.validate_physical_context(&compat), Ok(()));
}

#[test]
fn physical_full_ia32e_snapshots_retain_noncanonical_raw_bases_until_actual_use() {
    use crate::x86::context::{AccessFailure, ExecutionContext};
    let mut json = ExecutionContext::default().to_json();
    json["segments"]["fs"]["base"] = serde_json::json!("0x800000000000");
    json["segments"]["gs"]["base"] = serde_json::json!("0xffff7fff00000000");
    for root in ["gdtr", "idtr", "ldtr", "tr"] {
        json[root]["base"] = serde_json::json!("0x800000000001");
    }
    assert!(ExecutionContext::from_json(&json).is_err());
    let context = ExecutionContext::from_json_profile(&json, true).unwrap();
    assert_eq!(context.to_json(), json);
    assert!(matches!(
        context.translate(0, 8, Segment::Fs, Access::Read, false),
        Err(AccessFailure::Linear(crate::memory::Fault {
            cause: crate::memory::Cause::Noncanonical,
            ..
        }))
    ));
    json["mode"] = serde_json::json!("compatibility");
    json["segments"]["cs"]["long"] = serde_json::json!(false);
    let context = ExecutionContext::from_json_profile(&json, true).unwrap();
    assert_eq!(context.to_json(), json);
}

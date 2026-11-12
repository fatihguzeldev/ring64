use super::*;
use crate::x86::context::{
    LoadedSegment, Mode, SegmentAttributes, SegmentType, TableRegister, TaskRegister,
};
use crate::x86::instruction::{FarDescriptor, FarKind, Width};

fn compile_pending() -> u64 {
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    BRIDGE.with_borrow(|bridge| {
        let info: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
        u64::from_str_radix(info["owner"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    })
}

fn setup(epoch: u64) {
    let code = [0x9a, 0xff, 0xff, 0xff, 0xff, 0x3b, 0];
    initialize(0x1000, &code);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.image =
            crate::memory::Image::new(0x1000, code.to_vec(), 0x4000, vec![0; 0x6000]).unwrap();
        for (address, bytes) in [
            (0x6008, [0xff, 0xff, 0, 0, 0, 0x9b, 0xcf, 0]),
            (0x6010, [0xff, 0xff, 0, 0, 0, 0x93, 0xcf, 0]),
            (0x6018, [0xff, 0xff, 0, 0, 0, 0xfb, 0xcf, 0]),
            (0x6020, [0xff, 0xff, 0, 0, 0, 0xf3, 0xcf, 0]),
            (0x6038, [0, 0x20, 8, 0, 0, 0xec, 0, 0]),
        ] {
            core.image.write_bytes(address, &bytes).unwrap();
        }
        core.image
            .write_bytes(0x7004, &0x9000_u32.to_le_bytes())
            .unwrap();
        core.image
            .write_bytes(0x7008, &0x10_u16.to_le_bytes())
            .unwrap();
        core.context.set_mode_and_cpl(Mode::Protected, 3);
        let attributes = SegmentAttributes {
            dpl: 3,
            present: true,
            accessed: true,
            granularity: true,
            ..SegmentAttributes::default()
        };
        for segment in Segment::ALL {
            core.context.set_segment(
                segment,
                if segment == Segment::Cs { 0x1b } else { 0x23 },
                LoadedSegment {
                    kind: if segment == Segment::Cs {
                        SegmentType::ReadableCode
                    } else {
                        SegmentType::ReadWrite
                    },
                    ..LoadedSegment::default()
                },
                attributes,
            );
        }
        core.context.set_gdtr(TableRegister {
            base: 0x6000,
            limit: 0x7f,
        });
        core.context.set_tr(TaskRegister {
            selector: 0x28,
            valid: true,
            base: 0x7000,
            limit: 0x67,
            attributes: 0x8b,
        });
        core.context_version = epoch;
        unsafe {
            (*core.state.get()).flags = 2;
            (*core.state.get()).registers[4] = 0x4000;
        }
    });
}

fn transfer(kind: FarKind, sp: u64) -> i32 {
    far_control::core_far_control(
        FarDescriptor {
            kind,
            width: Width::W32,
            memory: false,
        }
        .encode(),
        if kind == FarKind::Call {
            0xffff_ffff
        } else {
            0
        },
        if kind == FarKind::Call { 0x3b } else { 0 },
        sp,
        if kind == FarKind::Call {
            0x1007
        } else {
            0x2001
        },
        if kind == FarKind::Call {
            Segment::Ds
        } else {
            Segment::Ss
        } as u32,
    )
}

#[test]
fn call_gate_round_trip_cancels_pending_owners_even_when_context_epoch_is_exhausted() {
    for epoch in [0, u64::MAX - 1, u64::MAX] {
        setup(epoch);
        let installed = compile_pending();
        assert_eq!(mapped::core_publish(installed), 1);
        let pending = compile_pending();
        assert_eq!(mapped::core_activate(installed), 1);
        let caller = BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().context.clone());

        assert_eq!(transfer(FarKind::Call, 0x4000), 0);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            assert_eq!(core.context.cpl(), 0);
            assert_eq!(core.context.selector(Segment::Cs), 8);
            assert_eq!(core.context.selector(Segment::Ss), 0x10);
            assert_eq!(core.context_version, epoch.saturating_add(1));
            assert_eq!(
                unsafe { (*core.state.get()).vector_scratch },
                [0, 0x20, 0, 0, 0, 0, 0, 0, 0xf0, 0x8f, 0, 0, 0, 0, 0, 0]
            );
            assert_eq!(
                core.image.read_bytes(0x8ff0, 16).unwrap(),
                [7, 0x10, 0, 0, 0x1b, 0, 0, 0, 0, 0x40, 0, 0, 0x23, 0, 0, 0]
            );
        });
        assert_eq!(
            mapped::core_validity(installed),
            1,
            "source is dormant, not dead"
        );
        assert_eq!(
            mapped::core_activate(installed),
            0,
            "callee cannot run caller code"
        );
        assert_eq!(
            mapped::core_validity(pending),
            0,
            "gate cancels pending publication"
        );
        assert_eq!(
            mapped::core_publish(pending),
            0,
            "cancelled work cannot adopt callee facts"
        );

        assert_eq!(transfer(FarKind::Return, 0x8ff0), 0);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            assert_eq!(
                core.context, caller,
                "matching RETF restores exact caller facts"
            );
            assert_eq!(core.context_version, epoch.saturating_add(2));
            assert_eq!(
                unsafe { (*core.state.get()).vector_scratch },
                [7, 0x10, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0, 0, 0, 0]
            );
        });
        assert_eq!(
            mapped::core_publish(pending),
            0,
            "A/B/A cannot resurrect pending work"
        );
        assert_eq!(mapped::core_activate(pending), 0);
        assert_eq!(
            mapped::core_activate(installed),
            1,
            "published caller owner is reusable"
        );
        let fresh = compile_pending();
        assert_eq!(
            mapped::core_publish(fresh),
            1,
            "exhausted epoch admits fresh work"
        );
        assert_eq!(mapped::core_activate(fresh), 1);
        mapped::core_release(pending);
        mapped::core_release(fresh);
        mapped::core_release(fresh);
        assert_eq!(mapped::core_validity(fresh), 0);
    }
}

use super::gate_review_tests::{expected_fault, gate};
use super::gate_tests::fixture;
use super::*;
use crate::memory::{Cause, Fault};
use std::cell::RefCell;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Traffic {
    SystemRead(u64, u32),
    OperandRead(u64, u32),
    SystemWriteCheck(u64, u32),
    FrameCheck(u64, u32, u8),
    Prepare,
    Write(u64, u32),
}

struct Probe {
    image: Image,
    traffic: RefCell<Vec<Traffic>>,
    refuse_frame: Option<u64>,
    refuse_parameter: Option<u64>,
    refuse_publication: bool,
}

impl Probe {
    fn new(image: Image) -> Self {
        Self {
            image,
            traffic: RefCell::new(Vec::new()),
            refuse_frame: None,
            refuse_parameter: None,
            refuse_publication: false,
        }
    }
    fn refusal(address: u64, width: u32, access: Access) -> AccessFailure {
        AccessFailure::Linear(Fault {
            address,
            width,
            access,
            cause: Cause::Permission,
            failing: u128::from(address),
        })
    }
}

impl GuestMemory for Probe {
    fn fetch(&self, address: u64) -> Result<u8, AccessFailure> {
        GuestMemory::fetch(&self.image, address)
    }
    fn read(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        GuestMemory::read(&self.image, address, width)
    }
    fn read_for_write(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        GuestMemory::read_for_write(&self.image, address, width)
    }
    fn read_vector(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure> {
        self.traffic
            .borrow_mut()
            .push(Traffic::OperandRead(address, width));
        if self.refuse_parameter == Some(address) {
            return Err(Self::refusal(address, width, Access::Read));
        }
        GuestMemory::read_vector(&self.image, address, width)
    }
    fn read_fields(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        output: &mut [u8],
    ) -> Result<(), AccessFailure> {
        self.traffic
            .borrow_mut()
            .push(Traffic::OperandRead(address, width));
        GuestMemory::read_fields(&self.image, address, width, fields, output)
    }
    fn write(&mut self, address: u64, width: u32, value: u64) -> Result<(), AccessFailure> {
        self.traffic.get_mut().push(Traffic::Write(address, width));
        GuestMemory::write(&mut self.image, address, width, value)
    }
    fn write_bytes(&mut self, address: u64, bytes: &[u8]) -> Result<(), AccessFailure> {
        GuestMemory::write_bytes(&mut self.image, address, bytes)
    }
    fn write_fields(
        &mut self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        bytes: &[u8],
    ) -> Result<(), AccessFailure> {
        GuestMemory::write_fields(&mut self.image, address, width, fields, bytes)
    }
    fn check_read(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        GuestMemory::check_read(&self.image, address, width)
    }
    fn check_write(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        GuestMemory::check_write(&self.image, address, width)
    }
    fn read_system(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure> {
        self.traffic
            .borrow_mut()
            .push(Traffic::SystemRead(address, width));
        GuestMemory::read_vector(&self.image, address, width)
    }
    fn check_system_write(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        self.traffic
            .borrow_mut()
            .push(Traffic::SystemWriteCheck(address, width));
        GuestMemory::check_write(&self.image, address, width)
    }
    fn check_frame_write(&self, address: u64, width: u32, cpl: u8) -> Result<(), AccessFailure> {
        self.traffic
            .borrow_mut()
            .push(Traffic::FrameCheck(address, width, cpl));
        if self.refuse_frame == Some(address) {
            return Err(Self::refusal(address, width, Access::Write));
        }
        GuestMemory::check_write(&self.image, address, width)
    }
    fn prepare_publication(&mut self) -> Result<(), AccessFailure> {
        self.traffic.get_mut().push(Traffic::Prepare);
        if self.refuse_publication {
            return Err(Self::refusal(0x3000, 1, Access::Write));
        }
        Ok(())
    }
}

fn inner(count: u8, accessed: bool) -> (ExecutionContext, Probe) {
    let (context, mut image) = fixture("protected");
    gate(&mut image, Width::W32, count, 8);
    image.write(0x2008, 2, 0x10).unwrap();
    image.write(0x2004, 4, 0x9000).unwrap();
    if !accessed {
        image.write(0x100d, 1, 0x9a).unwrap();
        image.write(0x1015, 1, 0x92).unwrap();
    }
    for index in 0..count {
        image
            .write(0x4000 + u64::from(index) * 4, 4, 0xa0 + u64::from(index))
            .unwrap();
    }
    (context, Probe::new(image))
}

fn run(
    context: &mut ExecutionContext,
    memory: &mut Probe,
    kind: FarKind,
) -> Result<FarOutcome, FarFailure> {
    execute(
        context,
        memory,
        FarDescriptor {
            kind,
            width: Width::W16,
            memory: false,
        },
        FarOperands {
            offset: 0xffff,
            selector: 0x3b,
            input_sp: 0x4000,
            next_pc: 0x1007,
            segment: Segment::Ds,
        },
    )
}

#[test]
fn parameter_capture_accessed_admission_new_cpl_frames_and_publication_have_exact_order() {
    let (mut context, mut memory) = inner(3, false);
    run(&mut context, &mut memory, FarKind::Call).unwrap();
    let mut expected = vec![
        Traffic::SystemRead(0x1038, 8),
        Traffic::SystemRead(0x1008, 8),
        Traffic::SystemRead(0x2008, 2),
        Traffic::SystemRead(0x2004, 4),
        Traffic::SystemRead(0x1010, 8),
        Traffic::OperandRead(0x4000, 4),
        Traffic::OperandRead(0x4004, 4),
        Traffic::OperandRead(0x4008, 4),
        Traffic::SystemWriteCheck(0x100d, 1),
        Traffic::SystemWriteCheck(0x1015, 1),
    ];
    expected.extend((0..7).map(|index| Traffic::FrameCheck(0x8ffc - index * 4, 4, 0)));
    expected.extend([
        Traffic::Prepare,
        Traffic::Write(0x100d, 1),
        Traffic::Write(0x1015, 1),
    ]);
    expected.extend((0..7).map(|index| Traffic::Write(0x8ffc - index * 4, 4)));
    assert_eq!(*memory.traffic.borrow(), expected);
    assert_eq!(
        (
            memory.image.read(0x100d, 1).unwrap(),
            memory.image.read(0x1015, 1).unwrap()
        ),
        (0x9b, 0x93)
    );
}

#[test]
fn every_one_of_35_frame_refusals_and_dirty_prepare_refusal_publishes_no_payload() {
    for refusal in 0..36 {
        let (mut context, mut memory) = inner(31, false);
        let before_context = context.clone();
        let before = memory.image.read_bytes(0, 0x11000).unwrap();
        if refusal == 35 {
            memory.refuse_publication = true;
        } else {
            memory.refuse_frame = Some(0x8ffc - refusal * 4);
        }
        assert!(matches!(
            run(&mut context, &mut memory, FarKind::Call),
            Err(FarFailure::Operand {
                segment: Segment::Ss,
                failure: AccessFailure::Linear(Fault {
                    cause: Cause::Permission,
                    access: Access::Write,
                    ..
                })
            })
        ));
        assert_eq!(context, before_context);
        assert_eq!(memory.image.read_bytes(0, 0x11000).unwrap(), before);
        assert!(
            !memory
                .traffic
                .borrow()
                .iter()
                .any(|access| matches!(access, Traffic::Write(..)))
        );
        assert_eq!(
            memory
                .traffic
                .borrow()
                .iter()
                .filter(|access| matches!(access, Traffic::OperandRead(..)))
                .count(),
            31
        );
        assert_eq!(
            memory
                .traffic
                .borrow()
                .iter()
                .filter(|access| matches!(access, Traffic::Prepare))
                .count(),
            usize::from(refusal == 35)
        );
    }
}

#[test]
fn final_parameter_refusal_precedes_all_payload_admission() {
    let (mut context, mut memory) = inner(31, false);
    let before_context = context.clone();
    let before = memory.image.read_bytes(0, 0x11000).unwrap();
    memory.refuse_parameter = Some(0x4078);
    memory.refuse_frame = Some(0x8ffc);
    assert_eq!(
        run(&mut context, &mut memory, FarKind::Call),
        Err(FarFailure::Operand {
            segment: Segment::Ss,
            failure: Probe::refusal(0x4078, 4, Access::Read)
        })
    );
    assert_eq!(context, before_context);
    assert_eq!(memory.image.read_bytes(0, 0x11000).unwrap(), before);
    assert!(!memory.traffic.borrow().iter().any(|access| matches!(
        access,
        Traffic::SystemWriteCheck(..)
            | Traffic::FrameCheck(..)
            | Traffic::Prepare
            | Traffic::Write(..)
    )));
    let parameters: Vec<_> = memory
        .traffic
        .borrow()
        .iter()
        .filter_map(|access| {
            if let Traffic::OperandRead(address, width) = access {
                Some((*address, *width))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        parameters,
        (0..31)
            .map(|index| (0x4000 + index * 4, 4))
            .collect::<Vec<_>>()
    );
}

#[test]
fn target_presence_new_ss_admission_geometry_and_offset_precede_parameters() {
    for scenario in 0..4 {
        let (mut context, mut memory) = inner(1, true);
        memory.refuse_parameter = Some(0x4000);
        match scenario {
            0 => {
                memory.image.write(0x100d, 1, 0x1b).unwrap(); // Target P0 before invalid TR.
                let mut tr = context.tr();
                tr.valid = false;
                context.set_tr(tr);
            }
            1 => {
                memory
                    .image
                    .write(0x1008, 8, 0x0040_9b00_0000_0fff)
                    .unwrap(); // Bad target offset.
                memory.image.write(0x1015, 1, 0x9b).unwrap(); // New SS is code.
            }
            2 => {
                memory
                    .image
                    .write(0x1008, 8, 0x0040_9b00_0000_0fff)
                    .unwrap();
                memory
                    .image
                    .write(0x1010, 8, 0x0040_9300_0000_0000)
                    .unwrap(); // First new-stack slot exceeds limit.
            }
            _ => {
                memory
                    .image
                    .write(0x1008, 8, 0x0040_9b00_0000_0fff)
                    .unwrap();
            }
        }
        let before = context.clone();
        let result = run(&mut context, &mut memory, FarKind::Call);
        match scenario {
            0 => expected_fault(result, 11, 8, ProtectionPhase::Descriptor),
            1 => expected_fault(result, 10, 0x10, ProtectionPhase::Descriptor),
            2 => expected_fault(result, 12, 0x10, ProtectionPhase::Target),
            _ => assert_eq!(result, Err(target_fault())),
        }
        assert_eq!(context, before);
        assert!(!memory.traffic.borrow().iter().any(|access| matches!(
            access,
            Traffic::OperandRead(..)
                | Traffic::FrameCheck(..)
                | Traffic::SystemWriteCheck(..)
                | Traffic::Prepare
                | Traffic::Write(..)
        )));
    }
}

#[test]
fn cached_tss_complete_limit_precedes_both_fields_and_ss_is_read_first() {
    for wide in [false, true] {
        for fits in [false, true] {
            let (mut context, mut memory) = inner(0, true);
            let mut tr = context.tr();
            tr.attributes = if wide { 0x8b } else { 0x83 };
            let last = if wide { 9 } else { 5 };
            tr.limit = last - u32::from(!fits);
            context.set_tr(tr);
            if !wide {
                memory.image.write(0x2004, 2, 0x10).unwrap();
                memory.image.write(0x2002, 2, 0x9000).unwrap();
            }
            let result = run(&mut context, &mut memory, FarKind::Call);
            if fits {
                result.unwrap();
            } else {
                expected_fault(result, 10, 0x28, ProtectionPhase::Descriptor);
            }
            let tss: Vec<_> = memory
                .traffic
                .borrow()
                .iter()
                .filter_map(|access| match access {
                    Traffic::SystemRead(address, width) if (0x2000..0x2100).contains(address) => {
                        Some((*address, *width))
                    }
                    _ => None,
                })
                .collect();
            assert_eq!(
                tss,
                if !fits {
                    vec![]
                } else if wide {
                    vec![(0x2008, 2), (0x2004, 4)]
                } else {
                    vec![(0x2004, 2), (0x2002, 2)]
                }
            );
        }
    }
}

#[test]
fn inner_count_zero_ignores_unusable_old_stack_but_count_one_checks_it() {
    for count in [0, 1] {
        let (mut context, mut memory) = inner(count, true);
        let mut ss = context.segment(Segment::Ss);
        ss.usable = false;
        ss.limit = 0;
        context.set_segment(Segment::Ss, 0x23, ss, context.attributes(Segment::Ss));
        let result = run(&mut context, &mut memory, FarKind::Call);
        if count == 0 {
            assert_eq!(result.unwrap().sp, 0x8ff0);
        } else {
            assert!(matches!(
                result,
                Err(FarFailure::Operand {
                    failure: AccessFailure::Segment(crate::x86::context::SegmentFault {
                        cause: crate::x86::context::SegmentCause::Unusable,
                        ..
                    }),
                    ..
                })
            ));
        }
        assert!(
            !memory
                .traffic
                .borrow()
                .iter()
                .any(|access| matches!(access, Traffic::OperandRead(..)))
        );
    }
}

#[test]
fn same_conforming_and_jump_never_consult_cached_tr_or_parameters() {
    for kind in [FarKind::Call, FarKind::Jump] {
        let (mut context, mut memory) = inner(31, true);
        let mut tr = context.tr();
        tr.valid = false;
        context.set_tr(tr);
        memory.refuse_parameter = Some(0x4000);
        memory
            .image
            .write(0x100d, 1, if kind == FarKind::Call { 0x9f } else { 0xfb })
            .unwrap();
        let outcome = run(&mut context, &mut memory, kind).unwrap();
        assert_eq!(
            (outcome.sp, context.cpl()),
            (
                if kind == FarKind::Call {
                    0x3ff8
                } else {
                    0x4000
                },
                3
            )
        );
        assert!(!memory.traffic.borrow().iter().any(|access| matches!(
            access,
            Traffic::OperandRead(..) | Traffic::SystemRead(0x2000..=0x20ff, _)
        )));
    }
}

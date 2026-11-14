use super::*;
use crate::memory::{Cause, Fault, Image, MappingInput, MemoryLimits, Permissions};
use crate::x86::context::{AccessFailure, Mode, Segment, SegmentCause};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Traffic {
    Read(u64, u32),
    Admit(u64, u32),
    Prepare,
    Write(u64, u32),
    Probe(u64),
    Observe(u64, u32, Access),
}

struct Memory {
    image: Image,
    trace: Rc<RefCell<Vec<Traffic>>>,
    steps: Cell<usize>,
    refuse: Option<usize>,
    refusal: Option<AccessFailure>,
}

impl Memory {
    fn new() -> Self {
        Self {
            image: Image::new(0x20000, vec![0x90], 0, vec![0xa5; 0x11000]).unwrap(),
            trace: Rc::default(),
            steps: Cell::new(0),
            refuse: None,
            refusal: None,
        }
    }

    fn record(&self, traffic: Traffic) -> Result<(), AccessFailure> {
        self.trace.borrow_mut().push(traffic);
        let step = self.steps.get() + 1;
        self.steps.set(step);
        if self.refuse == Some(step) {
            if let Some(failure) = self.refusal {
                return Err(failure);
            }
            let (address, width, access) = match traffic {
                Traffic::Read(a, w) => (a, w, Access::Read),
                Traffic::Admit(a, w) | Traffic::Write(a, w) => (a, w, Access::Write),
                Traffic::Probe(a) => (a, 1, Access::Write),
                Traffic::Prepare => (0xdead, 1, Access::Write),
                Traffic::Observe(_, _, _) => unreachable!(),
            };
            return Err(AccessFailure::Linear(Fault {
                address,
                width,
                access,
                cause: Cause::Permission,
                failing: address.into(),
            }));
        }
        Ok(())
    }
}

impl GuestMemory for Memory {
    fn fetch(&self, address: u64) -> Result<u8, AccessFailure> {
        GuestMemory::fetch(&self.image, address)
    }
    fn read(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        self.record(Traffic::Read(address, width))?;
        GuestMemory::read(&self.image, address, width)
    }
    fn read_for_write(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        GuestMemory::read_for_write(&self.image, address, width)
    }
    fn read_vector(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure> {
        GuestMemory::read_vector(&self.image, address, width)
    }
    fn read_fields(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        output: &mut [u8],
    ) -> Result<(), AccessFailure> {
        GuestMemory::read_fields(&self.image, address, width, fields, output)
    }
    fn write(&mut self, address: u64, width: u32, value: u64) -> Result<(), AccessFailure> {
        self.record(Traffic::Write(address, width))?;
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
        self.record(Traffic::Admit(address, width))?;
        GuestMemory::check_write(&self.image, address, width)
    }
    fn probe_write(&self, address: u64) -> Result<(), AccessFailure> {
        self.record(Traffic::Probe(address))?;
        GuestMemory::check_write(&self.image, address, 1)
    }
    fn prepare_publication(&mut self) -> Result<(), AccessFailure> {
        self.record(Traffic::Prepare)
    }
}

fn context(mode: Mode, stack32: bool, limit: u32) -> ExecutionContext {
    let mut context = ExecutionContext::default();
    context.set_mode_and_cpl(mode, if mode == Mode::Virtual8086 { 3 } else { 0 });
    let mut ss = context.segment(Segment::Ss);
    ss.default32 = stack32;
    ss.limit = limit;
    ss.base = 0;
    context.set_segment(Segment::Ss, 0, ss, context.attributes(Segment::Ss));
    context
}

fn registers(sp: u64, bp: u64) -> [u64; 16] {
    let mut banks = std::array::from_fn(|i| 0x1122334400000100 + i as u64);
    banks[4] = sp;
    banks[5] = bp;
    banks
}

fn enter(width: Width, allocation: u16, nesting: u8) -> CompoundStack {
    CompoundStack {
        kind: CompoundStackKind::Enter {
            allocation,
            nesting,
        },
        width,
    }
}

#[test]
fn descriptor_wire_is_canonical_and_mode_admission_is_separate() {
    for (width, bits) in [(Width::W16, 0), (Width::W32, 4), (Width::W64, 8)] {
        for nesting in 0..32 {
            for allocation in [0, 1, 0x1234, u16::MAX] {
                let op = enter(width, allocation, nesting);
                let word = bits | (u32::from(allocation) << 4) | (u32::from(nesting) << 20);
                assert_eq!(op.encode(), word);
                assert_eq!(CompoundStack::try_decode(word), Some(op));
            }
        }
        for (kind, value) in [
            (CompoundStackKind::PushAll, 1),
            (CompoundStackKind::PopAll, 2),
        ] {
            let op = CompoundStack { kind, width };
            assert_eq!(op.encode(), bits | value);
            assert_eq!(CompoundStack::try_decode(bits | value), Some(op));
            assert!(!op.valid_in_mode(&ExecutionContext::default()));
        }
    }
    for word in [
        3,
        12,
        13,
        14,
        15,
        0x11,
        0x12,
        0x100001,
        0x100002,
        1 << 25,
        u32::MAX,
    ] {
        assert_eq!(CompoundStack::try_decode(word), None, "{word:x}");
    }
    let legacy = context(Mode::Protected, true, u32::MAX);
    for width in [Width::W16, Width::W32, Width::W64, Width::W8] {
        assert_eq!(
            enter(width, 0, 0).valid_in_mode(&legacy),
            matches!(width, Width::W16 | Width::W32)
        );
        assert_eq!(
            enter(width, 0, 0).valid_in_mode(&ExecutionContext::default()),
            matches!(width, Width::W16 | Width::W64)
        );
    }
    assert!(!enter(Width::W16, 0, 32).valid_in_mode(&legacy));
    assert!(!enter(Width::W64, 0, u8::MAX).valid_in_mode(&ExecutionContext::default()));
}

#[test]
fn push_all_snapshots_original_raw_sp_and_wraps_each_complete_slot() {
    let mut memory = Memory::new();
    let mut banks = registers(0x1122334400010010, 0x5566778800021234);
    let before = banks;
    execute(
        &context(Mode::Protected, false, 0xffff),
        &mut memory,
        &mut banks,
        CompoundStack {
            kind: CompoundStackKind::PushAll,
            width: Width::W32,
        },
    )
    .unwrap();
    assert_eq!(banks[4], 0x112233440001fff0);
    assert_eq!(
        banks
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 4)
            .map(|(_, v)| *v)
            .collect::<Vec<_>>(),
        before
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 4)
            .map(|(_, v)| *v)
            .collect::<Vec<_>>()
    );
    for (address, bank) in [
        (0xc, 0),
        (8, 1),
        (4, 2),
        (0, 3),
        (0xfffc, 4),
        (0xfff8, 5),
        (0xfff4, 6),
        (0xfff0, 7),
    ] {
        assert_eq!(
            memory.image.read(address, 4).unwrap(),
            before[bank] & 0xffff_ffff
        );
    }
}

#[test]
fn enter_progressive_aliases_and_observations_follow_each_completed_slot() {
    let mut memory = Memory::new();
    memory.image = Image::mapped(
        vec![("ram".into(), vec![0xa5; 0x11000])],
        vec![MappingInput {
            base: 0,
            backing: "ram".into(),
            offset: 0,
            length: 0x11000,
            permissions: Permissions {
                read: true,
                write: true,
                execute: true,
            },
        }],
        MemoryLimits {
            max_backing_bytes: 0x11000,
            max_backings: 1,
            max_mappings: 1,
        },
    )
    .unwrap();
    memory.image.write(0x4ffc, 4, 0x11111111).unwrap();
    memory.image.write(0x4ff8, 4, 0x22222222).unwrap();
    let owner = memory.image.register_source([(0x4ffc, 4)]).unwrap();
    assert!(memory.image.activate(owner));
    let mut banks = registers(0x5000, 0x5000);
    let trace = memory.trace.clone();
    execute_observing(
        &context(Mode::Protected, true, u32::MAX),
        &mut memory,
        &mut banks,
        enter(Width::W32, 0, 3),
        &mut |a, w, x| trace.borrow_mut().push(Traffic::Observe(a, w, x)),
    )
    .unwrap();
    assert_eq!((banks[4], banks[5]), (0x4ff0, 0x4ffc));
    assert!(!memory.image.owner_valid(owner));
    assert!(memory.image.active_changed());
    for (address, value) in [
        (0x4ffc, 0x5000),
        (0x4ff8, 0x5000),
        (0x4ff4, 0x5000),
        (0x4ff0, 0x4ffc),
    ] {
        assert_eq!(memory.image.read(address, 4).unwrap(), value);
    }
    assert_eq!(
        *trace.borrow(),
        vec![
            Traffic::Admit(0x4ffc, 4),
            Traffic::Prepare,
            Traffic::Write(0x4ffc, 4),
            Traffic::Observe(0x4ffc, 4, Access::Write),
            Traffic::Read(0x4ffc, 4),
            Traffic::Observe(0x4ffc, 4, Access::Read),
            Traffic::Admit(0x4ff8, 4),
            Traffic::Prepare,
            Traffic::Write(0x4ff8, 4),
            Traffic::Observe(0x4ff8, 4, Access::Write),
            Traffic::Read(0x4ff8, 4),
            Traffic::Observe(0x4ff8, 4, Access::Read),
            Traffic::Admit(0x4ff4, 4),
            Traffic::Prepare,
            Traffic::Write(0x4ff4, 4),
            Traffic::Observe(0x4ff4, 4, Access::Write),
            Traffic::Admit(0x4ff0, 4),
            Traffic::Prepare,
            Traffic::Write(0x4ff0, 4),
            Traffic::Observe(0x4ff0, 4, Access::Write),
            Traffic::Probe(0x4ff0),
        ]
    );
}

#[test]
fn enter_uses_operand_raw_frame_temp_and_stack_sized_allocation() {
    for (width, stack32, sp, bp, allocation, expected_sp, expected_bp, address, value) in [
        (
            Width::W32,
            false,
            0x1122334400010010,
            0x5566778800021234,
            0,
            0x112233440001000c,
            0x556677880001000c,
            0xc,
            0x21234,
        ),
        (
            Width::W16,
            true,
            0x1122334400010002,
            0x5566778800021234,
            4,
            0x112233440000fffc,
            0x5566778800020000,
            0x10000,
            0x1234,
        ),
    ] {
        let mut memory = Memory::new();
        let mut banks = registers(sp, bp);
        let result = execute(
            &context(Mode::Protected, stack32, u32::MAX),
            &mut memory,
            &mut banks,
            enter(width, allocation, 0),
        );
        assert_eq!(result, Ok(()), "allocation must use the stack-sized cursor");
        assert_eq!((banks[4], banks[5]), (expected_sp, expected_bp));
        assert_eq!(
            memory
                .image
                .read(address, u32::from(width.bytes()))
                .unwrap(),
            value
        );
    }
}

#[test]
fn pop_all_skips_saved_sp_and_publishes_only_actual_ss_limit_prefix() {
    let mut memory = Memory::new();
    for (address, value) in [
        (0xfff4, 0x10101010),
        (0xfff8, 0x20202020),
        (0xfffc, 0x30303030),
    ] {
        memory.image.write(address, 4, value).unwrap();
    }
    let mut banks = registers(0x112233440000fff4, 0x5566778800005000);
    let before = banks;
    let result = execute(
        &context(Mode::Protected, true, 0xffff),
        &mut memory,
        &mut banks,
        CompoundStack {
            kind: CompoundStackKind::PopAll,
            width: Width::W32,
        },
    );
    assert!(
        matches!(result, Err(Failure::Operand(AccessFailure::Segment(s))) if s.cause == SegmentCause::Limit && s.offset == 0x10004)
    );
    assert_eq!(
        (banks[7], banks[6], banks[5]),
        (0x1122334410101010, 0x1122334420202020, 0x5566778830303030)
    );
    for i in [0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15] {
        assert_eq!(banks[i], before[i]);
    }
    assert_eq!(
        *memory.trace.borrow(),
        vec![
            Traffic::Read(0xfff4, 4),
            Traffic::Read(0xfff8, 4),
            Traffic::Read(0xfffc, 4)
        ]
    );
}

#[test]
fn failed_enter_keeps_completed_payload_but_rolls_back_all_banks() {
    let mut memory = Memory::new();
    memory.refuse = Some(7); // refuse the second payload after the first complete push
    let mut banks = registers(0x5000, 0x5000);
    let before = banks;
    let result = execute(
        &context(Mode::Protected, true, u32::MAX),
        &mut memory,
        &mut banks,
        enter(Width::W32, 0, 3),
    );
    assert!(matches!(
        result,
        Err(Failure::Operand(AccessFailure::Linear(_)))
    ));
    assert_eq!(banks, before);
    assert_eq!(memory.image.read(0x4ffc, 4).unwrap(), 0x5000);
    assert_eq!(memory.image.read(0x4ff8, 4).unwrap(), 0xa5a5a5a5);
}

#[test]
fn canonical_real_small_stack_keeps_ordered_payload_and_private_priority() {
    for refuse in [None, Some(1)] {
        let mut memory = Memory::new();
        memory.refuse = refuse;
        let mut banks = registers(3, 0x1234);
        let before = banks;
        let result = execute(
            &context(Mode::Real, false, 0xffff),
            &mut memory,
            &mut banks,
            CompoundStack {
                kind: CompoundStackKind::PushAll,
                width: Width::W16,
            },
        );
        assert_eq!(banks, before);
        if refuse.is_some() {
            assert!(matches!(
                result,
                Err(Failure::Operand(AccessFailure::Linear(_)))
            ));
            assert_eq!(memory.image.read(1, 2).unwrap(), 0xa5a5);
        } else {
            assert!(
                matches!(result, Err(Failure::Operand(AccessFailure::Segment(s))) if s.cause == SegmentCause::Limit && s.offset == 0xffff)
            );
            assert_eq!(memory.image.read(1, 2).unwrap(), 0x100);
        }
    }
}

#[test]
fn every_nesting_level_and_width_has_exact_bounded_stack_traffic() {
    for (width, stack_bits) in [
        (Width::W16, 16),
        (Width::W32, 16),
        (Width::W16, 32),
        (Width::W32, 32),
        (Width::W16, 64),
        (Width::W64, 64),
    ] {
        let size = u64::from(width.bytes());
        let mode = if stack_bits == 64 {
            Mode::Long64
        } else {
            Mode::Protected
        };
        let context = context(mode, stack_bits == 32, u32::MAX);
        for nesting in 0..32 {
            let mut memory = Memory::new();
            for i in 1..31 {
                memory
                    .image
                    .write(0x8000 - i * size, size as u32, 0x1000 + i)
                    .unwrap();
            }
            let mut banks = registers(0x5000, 0x8000);
            let before = banks;
            execute(&context, &mut memory, &mut banks, enter(width, 0, nesting)).unwrap();
            let pushes = if nesting == 0 {
                1
            } else {
                u64::from(nesting) + 1
            };
            let frame = 0x5000 - size;
            assert_eq!(banks[4], 0x5000 - size * pushes);
            assert_eq!(banks[5], frame);
            assert_eq!(memory.image.read(frame, size as u32).unwrap(), 0x8000);
            for i in 1..u64::from(nesting) {
                assert_eq!(
                    memory
                        .image
                        .read(0x5000 - size * (i + 1), size as u32)
                        .unwrap(),
                    0x1000 + i
                );
            }
            if nesting != 0 {
                assert_eq!(memory.image.read(banks[4], size as u32).unwrap(), frame);
            }
            for i in [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] {
                assert_eq!(banks[i], before[i]);
            }
            let trace = memory.trace.borrow();
            assert_eq!(
                trace
                    .iter()
                    .filter(|e| matches!(e, Traffic::Write(_, _)))
                    .count(),
                pushes as usize
            );
            assert_eq!(
                trace
                    .iter()
                    .filter(|e| matches!(e, Traffic::Read(_, _)))
                    .count(),
                usize::from(nesting.saturating_sub(1))
            );
            assert_eq!(trace.last(), Some(&Traffic::Probe(banks[4])));
            assert_eq!(
                trace.len(),
                pushes as usize * 3 + usize::from(nesting.saturating_sub(1)) + 1
            );
        }
    }
}

#[test]
fn every_enter_refusal_frontier_retains_only_completed_payloads() {
    let full_trace = [
        Traffic::Admit(0x4ffc, 4),
        Traffic::Prepare,
        Traffic::Write(0x4ffc, 4),
        Traffic::Read(0x4ffc, 4),
        Traffic::Admit(0x4ff8, 4),
        Traffic::Prepare,
        Traffic::Write(0x4ff8, 4),
        Traffic::Read(0x4ff8, 4),
        Traffic::Admit(0x4ff4, 4),
        Traffic::Prepare,
        Traffic::Write(0x4ff4, 4),
        Traffic::Admit(0x4ff0, 4),
        Traffic::Prepare,
        Traffic::Write(0x4ff0, 4),
        Traffic::Probe(0x4ff0),
    ];
    for frontier in 1..=15 {
        let mut memory = Memory::new();
        memory.refuse = Some(frontier);
        let mut banks = registers(0x5000, 0x5000);
        let before = banks;
        let result = execute(
            &context(Mode::Protected, true, u32::MAX),
            &mut memory,
            &mut banks,
            enter(Width::W32, 0, 3),
        );
        assert!(matches!(
            result,
            Err(Failure::Operand(AccessFailure::Linear(_)))
        ));
        assert_eq!(banks, before, "frontier {frontier}");
        assert_eq!(*memory.trace.borrow(), full_trace[..frontier]);
        for (address, value, write_step) in [
            (0x4ffc, 0x5000, 3),
            (0x4ff8, 0x5000, 7),
            (0x4ff4, 0x5000, 11),
            (0x4ff0, 0x4ffc, 14),
        ] {
            assert_eq!(
                memory.image.read(address, 4).unwrap(),
                if frontier > write_step {
                    value
                } else {
                    0xa5a5a5a5
                },
                "frontier {frontier}, address {address:x}"
            );
        }
    }
}

#[test]
fn every_push_all_refusal_keeps_original_banks_and_an_exact_store_prefix() {
    for frontier in 1..=24 {
        let mut memory = Memory::new();
        memory.refuse = Some(frontier);
        let mut banks = registers(0x5000, 0x1234);
        let before = banks;
        let result = execute(
            &context(Mode::Protected, true, u32::MAX),
            &mut memory,
            &mut banks,
            CompoundStack {
                kind: CompoundStackKind::PushAll,
                width: Width::W32,
            },
        );
        assert!(matches!(
            result,
            Err(Failure::Operand(AccessFailure::Linear(_)))
        ));
        assert_eq!(banks, before);
        assert_eq!(memory.trace.borrow().len(), frontier);
        for (i, value) in before[..8].iter().enumerate() {
            assert_eq!(
                memory.image.read(0x5000 - 4 * (i as u64 + 1), 4).unwrap(),
                if frontier > (i + 1) * 3 {
                    value & 0xffff_ffff
                } else {
                    0xa5a5a5a5
                }
            );
        }
    }
}

#[test]
fn pop_all_private_page_and_nonlimit_refusals_never_publish_a_candidate() {
    for frontier in 1..=7 {
        for flavor in 0..4 {
            let mut memory = Memory::new();
            memory.refuse = Some(frontier);
            memory.refusal = match flavor {
                0 => None,
                1 => Some(AccessFailure::Paging(
                    crate::x86::paging::walk::Failure::Page(crate::x86::paging::walk::PageFault {
                        address: 0x4000,
                        access: Access::Read,
                        error_code: 0,
                    }),
                )),
                _ => Some(AccessFailure::Segment(crate::x86::context::SegmentFault {
                    segment: Segment::Ss,
                    offset: 0x4000,
                    width: 4,
                    access: Access::Read,
                    cause: if flavor == 2 {
                        SegmentCause::Type
                    } else {
                        SegmentCause::Unusable
                    },
                    failing: 0x4000,
                })),
            };
            let mut banks = registers(0x4000, 0x1234);
            let before = banks;
            assert!(
                execute(
                    &context(Mode::Protected, true, u32::MAX),
                    &mut memory,
                    &mut banks,
                    CompoundStack {
                        kind: CompoundStackKind::PopAll,
                        width: Width::W32
                    }
                )
                .is_err()
            );
            assert_eq!(banks, before, "frontier {frontier}, flavor {flavor}");
            assert_eq!(memory.trace.borrow().len(), frontier);
        }
    }
}

#[test]
fn every_actual_popa_limit_frontier_exposes_only_the_successful_read_views() {
    const BANKS: [usize; 7] = [7, 6, 5, 3, 2, 1, 0];
    const SLOTS: [u64; 7] = [0, 1, 2, 4, 5, 6, 7];
    for width in [Width::W16, Width::W32] {
        let size = u64::from(width.bytes());
        for (frontier, slot) in SLOTS.into_iter().enumerate() {
            let mut memory = Memory::new();
            for (i, slot) in SLOTS.into_iter().enumerate() {
                memory
                    .image
                    .write(0x4000 + slot * size, size as u32, 0x1230 + i as u64)
                    .unwrap();
            }
            let limit = (0x4000 + slot * size - 1) as u32;
            let mut banks = registers(0x1122334400004000, 0x5566778800005000);
            let before = banks;
            let result = execute(
                &context(Mode::Protected, true, limit),
                &mut memory,
                &mut banks,
                CompoundStack {
                    kind: CompoundStackKind::PopAll,
                    width,
                },
            );
            assert!(
                matches!(result, Err(Failure::Operand(AccessFailure::Segment(s))) if s.cause == SegmentCause::Limit)
            );
            let mut expected = before;
            for i in 0..frontier {
                expected[BANKS[i]] = (before[BANKS[i]] & !width.mask()) | (0x1230 + i as u64);
            }
            assert_eq!(banks, expected);
            assert_eq!(memory.trace.borrow().len(), frontier);
        }
    }
}

#[test]
fn popa_skipped_slot_has_no_backing_or_segment_read_even_when_it_crosses_the_limit() {
    let mut memory = Memory::new();
    memory.refuse = Some(8); // there are only seven actual reads
    let mut banks = registers(0x112233440000fff3, 0x5566778800005000);
    let result = execute(
        &context(Mode::Protected, false, 0xffff),
        &mut memory,
        &mut banks,
        CompoundStack {
            kind: CompoundStackKind::PopAll,
            width: Width::W32,
        },
    );
    assert_eq!(result, Ok(()), "saved-SP slot must not be read");
    assert_eq!(banks[4], 0x1122334400000013);
    assert_eq!(
        *memory.trace.borrow(),
        vec![
            Traffic::Read(0xfff3, 4),
            Traffic::Read(0xfff7, 4),
            Traffic::Read(0xfffb, 4),
            Traffic::Read(3, 4),
            Traffic::Read(7, 4),
            Traffic::Read(0xb, 4),
            Traffic::Read(0xf, 4),
        ]
    );
    for i in [0, 1, 2, 3, 5, 6, 7] {
        assert_eq!(banks[i] & 0xffff_ffff, 0xa5a5a5a5);
    }
}

#[test]
fn enter_probe_is_one_byte_and_does_not_scan_an_unmapped_allocation_gap() {
    for endpoint_writable in [true, false] {
        let mut memory = Memory::new();
        memory.image = Image::mapped(
            vec![("ram".into(), vec![0xa5; 9])],
            vec![(0x3fff, 0, 1), (0x6ff8, 1, 8)]
                .into_iter()
                .map(|(base, offset, length)| MappingInput {
                    base,
                    backing: "ram".into(),
                    offset,
                    length,
                    permissions: Permissions {
                        read: true,
                        write: base != 0x3fff || endpoint_writable,
                        execute: false,
                    },
                })
                .collect(),
            MemoryLimits {
                max_backing_bytes: 9,
                max_backings: 1,
                max_mappings: 2,
            },
        )
        .unwrap();
        let mut banks = registers(0x7000, 0x8000);
        let before = banks;
        let result = execute(
            &ExecutionContext::default(),
            &mut memory,
            &mut banks,
            enter(Width::W64, 0x2ff9, 0),
        );
        if endpoint_writable {
            assert_eq!(result, Ok(()));
            assert_eq!((banks[4], banks[5]), (0x3fff, 0x6ff8));
        } else {
            assert!(
                matches!(
                    result,
                    Err(Failure::Operand(AccessFailure::Linear(Fault {
                        address: 0x3fff,
                        width: 1,
                        access: Access::Write,
                        cause: Cause::Permission,
                        ..
                    })))
                ),
                "the endpoint must require write permission"
            );
            assert_eq!(banks, before);
        }
        assert_eq!(memory.image.read(0x6ff8, 8).unwrap(), 0x8000);
        assert_eq!(
            *memory.trace.borrow(),
            vec![
                Traffic::Admit(0x6ff8, 8),
                Traffic::Prepare,
                Traffic::Write(0x6ff8, 8),
                Traffic::Probe(0x3fff)
            ]
        );
        assert_eq!(memory.image.read(0x3fff, 1).unwrap(), 0xa5);
        assert!(memory.image.check_write(0x3fff, 2).is_err());
    }
}

#[test]
fn enter_endpoint_byte_can_be_the_last_byte_of_the_stack_segment() {
    let mut memory = Memory::new();
    let mut banks = registers(2, 0x1234);
    let result = execute(
        &context(Mode::Protected, false, 0xffff),
        &mut memory,
        &mut banks,
        enter(Width::W16, 1, 0),
    );
    assert_eq!(
        result,
        Ok(()),
        "final endpoint is one byte, not an operand span"
    );
    assert_eq!((banks[4], banks[5]), (0xffff, 0));
    assert_eq!(memory.image.read(0, 2).unwrap(), 0x1234);
    assert_eq!(memory.image.read(0xffff, 1).unwrap(), 0xa5);
    assert_eq!(memory.trace.borrow().last(), Some(&Traffic::Probe(0xffff)));
}

#[test]
fn long64_word_enter_preserves_high_bp_and_uses_high_stack_addresses() {
    for nesting in [0, 2] {
        let mut memory = Memory::new();
        memory.image = Image::new(0x20000, vec![0x90], 0x100000000, vec![0xa5; 0x2000]).unwrap();
        memory.image.write(0x100001233, 2, 0xbeef).unwrap();
        let mut banks = registers(0x100000010, 0x100001235);
        let result = execute(
            &ExecutionContext::default(),
            &mut memory,
            &mut banks,
            enter(Width::W16, 8, nesting),
        );
        assert_eq!(
            result,
            Ok(()),
            "high stack and chain addresses must remain 64-bit"
        );
        assert_eq!(banks[5], 0x10000000e);
        assert_eq!(memory.image.read(0x10000000e, 2).unwrap(), 0x1235);
        let mut expected = vec![
            Traffic::Admit(0x10000000e, 2),
            Traffic::Prepare,
            Traffic::Write(0x10000000e, 2),
        ];
        if nesting != 0 {
            assert_eq!(banks[4], 0x100000002);
            assert_eq!(memory.image.read(0x10000000c, 2).unwrap(), 0xbeef);
            assert_eq!(memory.image.read(0x10000000a, 2).unwrap(), 0xe);
            expected.extend([
                Traffic::Read(0x100001233, 2),
                Traffic::Admit(0x10000000c, 2),
                Traffic::Prepare,
                Traffic::Write(0x10000000c, 2),
                Traffic::Admit(0x10000000a, 2),
                Traffic::Prepare,
                Traffic::Write(0x10000000a, 2),
                Traffic::Probe(0x100000002),
            ]);
        } else {
            assert_eq!(banks[4], 0x100000006);
            expected.push(Traffic::Probe(0x100000006));
        }
        assert_eq!(*memory.trace.borrow(), expected);
    }
}

#[test]
fn low_odd_general_protection_is_canonical_only_and_precedes_private_access() {
    for mode in [Mode::Real, Mode::Virtual8086] {
        for sp in [7, 9, 11, 13, 15] {
            for width in [Width::W16, Width::W32] {
                let mut memory = Memory::new();
                memory.refuse = Some(1);
                let mut banks = registers(0x1122334400000000 | sp, 0x1234);
                let before = banks;
                assert!(matches!(
                    execute(
                        &context(mode, false, 0xffff),
                        &mut memory,
                        &mut banks,
                        CompoundStack {
                            kind: CompoundStackKind::PushAll,
                            width
                        }
                    ),
                    Err(Failure::Protection(ProtectionFault {
                        vector: 13,
                        error_code: 0,
                        ..
                    }))
                ));
                assert_eq!(banks, before);
                assert!(memory.trace.borrow().is_empty());
            }
        }
    }
    for (stack32, limit, sp) in [(true, u32::MAX, 7), (false, 0x1ffff, 7), (false, 0xffff, 0)] {
        let mut memory = Memory::new();
        let mut banks = registers(sp, 0x1234);
        let result = execute(
            &context(Mode::Real, stack32, limit),
            &mut memory,
            &mut banks,
            CompoundStack {
                kind: CompoundStackKind::PushAll,
                width: Width::W16,
            },
        );
        if stack32 {
            assert!(
                matches!(result, Err(Failure::Operand(AccessFailure::Segment(s))) if s.offset == u64::from(u32::MAX) && s.cause == SegmentCause::Limit)
            );
            assert_eq!(memory.trace.borrow().len(), 9);
        } else {
            result.unwrap();
            assert_eq!(memory.trace.borrow().len(), 24);
        }
    }
}

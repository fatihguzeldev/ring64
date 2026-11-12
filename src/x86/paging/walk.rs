use super::State;
use crate::memory::{Access, Fault, Image};

const ADDRESS: u64 = 0x000f_ffff_ffff_f000;
const ACCESSED: u64 = 1 << 5;
pub const DIRTY: u64 = 1 << 6;

#[cfg(test)]
pub(crate) mod physical_counts {
    use std::cell::Cell;

    // Attempted Image calls and requested byte widths, in this order:
    // read/read-bytes, write-check/check-bytes, write/write-bytes.
    thread_local! { static COUNTS: Cell<[u64; 6]> = const { Cell::new([0; 6]) }; }

    fn record(slot: usize, width: u32) {
        COUNTS.with(|counts| {
            let mut current = counts.get();
            current[slot] += 1;
            current[slot + 1] += u64::from(width);
            counts.set(current);
        });
    }
    pub fn read(width: u32) {
        record(0, width);
    }
    pub fn check(width: u32) {
        record(2, width);
    }
    pub fn write(width: u32) {
        record(4, width);
    }
    pub fn take() -> [u64; 6] {
        COUNTS.with(|counts| counts.replace([0; 6]))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub linear: u64,
    pub access: Access,
    pub user: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PageFault {
    pub address: u64,
    pub access: Access,
    pub error_code: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhysicalPhase {
    WalkRead,
    AccessedWrite,
    DirtyWrite,
    FinalAccess,
}

impl PhysicalPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WalkRead => "walk-read",
            Self::AccessedWrite => "accessed-write",
            Self::DirtyWrite => "dirty-write",
            Self::FinalAccess => "final-access",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhysicalFault {
    pub linear: u64,
    pub access: Access,
    pub physical: Fault,
    pub phase: PhysicalPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Page(PageFault),
    Physical(PhysicalFault),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Translation {
    pub physical: u64,
    pub leaf: u64,
    pub dirty: bool,
    pub remaining: u64,
    pub entry_width: u32,
    entries: [u64; 4],
    count: usize,
}

impl Translation {
    pub fn entries(&self) -> &[u64] {
        &self.entries[..self.count]
    }
}

impl Request {
    fn page_fault(self, state: &State, present: bool, reserved: bool) -> Failure {
        Failure::Page(PageFault {
            address: self.linear,
            access: self.access,
            error_code: u32::from(present)
                | (u32::from(self.access == Access::Write) << 1)
                | (u32::from(self.user) << 2)
                | (u32::from(reserved) << 3)
                | (u32::from(
                    self.access == Access::Execute
                        && (state.efer & (1 << 10) != 0 || state.cr4 & (1 << 5) != 0)
                        && state.efer & (1 << 11) != 0,
                ) << 4),
        })
    }

    pub fn physical_failure(self, physical: Fault, phase: PhysicalPhase) -> Failure {
        Failure::Physical(PhysicalFault {
            linear: self.linear,
            access: self.access,
            physical,
            phase,
        })
    }
}

pub fn peek(image: &Image, state: &State, request: Request) -> Result<Translation, Failure> {
    walk_with::<false, false>(state, request, |address, width, _| {
        #[cfg(test)]
        physical_counts::read(width);
        image.physical_read(address, width).map(Some)
    })
    .map(|translation| translation.expect("observational walk cannot restart"))
}

pub fn walk(image: &mut Image, state: &State, request: Request) -> Result<Translation, Failure> {
    actual_walk::<false>(image, state, request, |_| true)
        .map(|translation| translation.expect("ordinary access does not abandon a walk"))
}

/// Stop a required-byte walk immediately when an A write invalidates consumed encoding.
pub fn fetch_walk(
    image: &mut Image,
    state: &State,
    request: Request,
    current: impl FnMut(&Image) -> bool,
) -> Result<Option<Translation>, Failure> {
    actual_walk::<true>(image, state, request, current)
}

fn actual_walk<const FETCH: bool>(
    image: &mut Image,
    state: &State,
    request: Request,
    mut current: impl FnMut(&Image) -> bool,
) -> Result<Option<Translation>, Failure> {
    walk_with::<true, FETCH>(state, request, |address, width, accessed| {
        if accessed {
            #[cfg(test)]
            physical_counts::check(width);
            image.physical_check_write(address, width)?;
            #[cfg(test)]
            physical_counts::read(width);
            let current_word = image.physical_read(address, width)?;
            #[cfg(test)]
            physical_counts::write(width);
            image.physical_write(address, width, current_word | ACCESSED)?;
            Ok(current(image).then_some(current_word | ACCESSED))
        } else {
            #[cfg(test)]
            physical_counts::read(width);
            image.physical_read(address, width).map(Some)
        }
    })
}

fn walk_with<const EFFECTS: bool, const FETCH: bool>(
    state: &State,
    request: Request,
    entry_access: impl FnMut(u64, u32, bool) -> Result<Option<u64>, Fault>,
) -> Result<Option<Translation>, Failure> {
    if state.cr0 & (1 << 31) == 0 {
        if request.linear >= 1u64 << 32 {
            return Err(request.physical_failure(
                Fault {
                    address: request.linear,
                    width: 1,
                    access: request.access,
                    cause: crate::memory::Cause::AddressRange,
                    failing: 1u128 << 32,
                },
                PhysicalPhase::FinalAccess,
            ));
        }
        return Ok(Some(Translation {
            physical: request.linear,
            leaf: 0,
            dirty: false,
            remaining: (1u64 << 32) - request.linear,
            entry_width: 0,
            entries: [0; 4],
            count: 0,
        }));
    }
    if state.efer & (1 << 10) != 0 {
        walk_paged_with::<EFFECTS, FETCH, true, true>(state, request, entry_access)
    } else if state.cr4 & (1 << 5) != 0 {
        walk_paged_with::<EFFECTS, FETCH, false, true>(state, request, entry_access)
    } else {
        walk_paged_with::<EFFECTS, FETCH, false, false>(state, request, entry_access)
    }
}

// Keep one set of walk/effect rules while specializing geometry and entry width.
fn walk_paged_with<const EFFECTS: bool, const FETCH: bool, const IA32E: bool, const PAE: bool>(
    state: &State,
    request: Request,
    mut entry_access: impl FnMut(u64, u32, bool) -> Result<Option<u64>, Fault>,
) -> Result<Option<Translation>, Failure> {
    let entry_width = if IA32E || PAE { 8 } else { 4 };
    let shifts: &[u32] = if IA32E {
        &[39, 30, 21, 12]
    } else if PAE {
        &[21, 12]
    } else {
        &[22, 12]
    };
    let mut table = if IA32E {
        state.cr3 & ADDRESS
    } else {
        state.cr3 & 0xfffff000
    };
    if !IA32E && PAE {
        let root =
            state.pdpte.expect("validated legacy PAE quartet")[(request.linear >> 30 & 3) as usize];
        if root & 1 == 0 {
            return Err(request.page_fault(state, false, false));
        }
        table = root & ADDRESS;
    }
    let mut user = true;
    let mut writable = true;
    let mut executable = true;
    let mut entries = [0; 4];
    let mut words = [0; 4];
    for (index, &shift) in shifts.iter().enumerate() {
        let address = table
            + ((request.linear >> shift) & if entry_width == 4 { 1023 } else { 511 })
                * u64::from(entry_width);
        entries[index] = address;
        let Some(entry) = entry_access(address, entry_width, false)
            .map_err(|f| request.physical_failure(f, PhysicalPhase::WalkRead))?
        else {
            return Ok(None);
        };
        words[index] = entry;
        if entry & 1 == 0 {
            return Err(request.page_fault(state, false, false));
        }
        let large = index + 1 < shifts.len()
            && entry & (1 << 7) != 0
            && (entry_width == 8 || state.cr4 & (1 << 4) != 0);
        let leaf = index + 1 == shifts.len() || large;
        let reserved_address = large
            && if entry_width == 4 {
                entry & (1 << 21) != 0
            } else {
                entry & (((1u64 << shift) - 1) & !0x1fff) != 0
            };
        if IA32E && index == 0 && large
            || reserved_address
            || !IA32E && PAE && entry & 0x7ff0000000000000 != 0
            || state.efer & (1 << 11) == 0 && entry & (1 << 63) != 0
        {
            return Err(request.page_fault(state, true, true));
        }
        if EFFECTS && entry & ACCESSED == 0 {
            if entry_access(address, entry_width, true)
                .map_err(|f| request.physical_failure(f, PhysicalPhase::AccessedWrite))?
                .is_none()
            {
                return Ok(None);
            }
            if FETCH {
                // An A alias can redirect this byte's already-read hierarchy before a lower fault.
                for used in 0..=index {
                    let Some(current) = entry_access(entries[used], entry_width, false)
                        .map_err(|f| request.physical_failure(f, PhysicalPhase::WalkRead))?
                    else {
                        return Ok(None);
                    };
                    if (current ^ words[used]) & !ACCESSED != 0 {
                        return Ok(None);
                    }
                }
            }
        }
        user &= entry & 4 != 0;
        writable &= entry & 2 != 0;
        executable &= entry & (1 << 63) == 0;
        if leaf {
            if request.user && !user
                || request.access == Access::Write
                    && !writable
                    && (request.user || state.cr0 & (1 << 16) != 0)
                || request.access == Access::Execute && !executable
            {
                return Err(request.page_fault(state, true, false));
            }
            let offset_mask = (1u64 << shift) - 1;
            return Ok(Some(Translation {
                physical: (if entry_width == 4 && large {
                    (entry & 0xffc00000) | ((entry & 0x001fe000) << 19)
                } else {
                    entry & ADDRESS & !offset_mask
                }) | (request.linear & offset_mask),
                leaf: address,
                dirty: entry & DIRTY == 0,
                remaining: (1u64 << shift) - (request.linear & offset_mask),
                entry_width,
                entries,
                count: index + 1,
            }));
        }
        table = entry & ADDRESS;
    }
    unreachable!("four-level walk always reaches a PTE")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MappingInput, MemoryLimits, Permissions};

    fn fixture() -> (Image, State) {
        let mut bytes = vec![0; 0x5000];
        for (offset, word) in [
            (0x1000, 0x2007u64),
            (0x2000, 0x3007),
            (0x3000, 0x4007),
            (0x4008, 0xa007),
        ] {
            bytes[offset..offset + 8].copy_from_slice(&word.to_le_bytes());
        }
        let image = Image::physical_mapped(
            vec![("tables".into(), bytes)],
            vec![MappingInput {
                base: 0,
                backing: "tables".into(),
                offset: 0,
                length: 0x5000,
                permissions: Permissions {
                    read: true,
                    write: true,
                    execute: false,
                },
            }],
            MemoryLimits {
                max_backing_bytes: 0x5000,
                max_backings: 1,
                max_mappings: 1,
            },
        )
        .unwrap();
        (
            image,
            State {
                cr3: 0x1000,
                ..State::default()
            },
        )
    }

    #[test]
    fn literal_nonidentity_walk_peeks_without_accessed_effects() {
        let (image, state) = fixture();
        let request = Request {
            linear: 0x1234,
            access: Access::Read,
            user: true,
        };
        let result = peek(&image, &state, request).unwrap();
        assert_eq!(
            (result.physical, result.leaf, result.dirty),
            (0xa234, 0x4008, true)
        );
        assert_eq!(result.entries(), &[0x1000, 0x2000, 0x3000, 0x4008]);
        assert_eq!(image.physical_read(0x1000, 8).unwrap(), 0x2007);
    }

    #[test]
    fn actual_walk_sets_only_visited_valid_accessed_bits_before_nonpresent() {
        let (mut image, state) = fixture();
        let failure = walk(
            &mut image,
            &state,
            Request {
                linear: 0x2000,
                access: Access::Write,
                user: true,
            },
        )
        .unwrap_err();
        assert_eq!(
            failure,
            Failure::Page(PageFault {
                address: 0x2000,
                access: Access::Write,
                error_code: 6
            })
        );
        for (address, word) in [(0x1000, 0x2027), (0x2000, 0x3027), (0x3000, 0x4027)] {
            assert_eq!(image.physical_read(address, 8).unwrap(), word);
        }
        assert_eq!(image.physical_read(0x4010, 8).unwrap(), 0);
    }

    #[test]
    fn leaf_permission_and_nx_error_codes_use_literal_access_provenance() {
        for (user, access, wp, nxe, leaf, expected) in [
            (true, Access::Write, true, false, 0xa005, 7),
            (false, Access::Write, true, false, 0xa005, 3),
            (true, Access::Execute, false, true, 0x800000000000a007, 21),
            (true, Access::Read, false, false, 0x800000000000a007, 13),
            (true, Access::Execute, false, true, 0, 20),
            (true, Access::Execute, false, false, 0, 4),
        ] {
            let (mut image, mut state) = fixture();
            state.cr0 |= u64::from(wp) << 16;
            state.efer |= u64::from(nxe) << 11;
            image.physical_write(0x4008, 8, leaf).unwrap();
            assert_eq!(
                walk(
                    &mut image,
                    &state,
                    Request {
                        linear: 0x1234,
                        access,
                        user
                    }
                ),
                Err(Failure::Page(PageFault {
                    address: 0x1234,
                    access,
                    error_code: expected
                }))
            );
            assert_eq!(image.physical_read(0x4008, 8).unwrap() & 64, 0);
        }
    }

    #[test]
    fn lower_absence_precedes_upper_permission_and_nonpresent_garbage_is_not_reserved() {
        let (mut image, state) = fixture();
        image.physical_write(0x1000, 8, 0x2001).unwrap();
        image.physical_write(0x4008, 8, 0xfffffffffffffffe).unwrap();
        assert_eq!(
            walk(
                &mut image,
                &state,
                Request {
                    linear: 0x1234,
                    access: Access::Read,
                    user: true
                }
            ),
            Err(Failure::Page(PageFault {
                address: 0x1234,
                access: Access::Read,
                error_code: 4
            }))
        );
        assert_eq!(image.physical_read(0x4008, 8).unwrap(), 0xfffffffffffffffe);
    }

    #[test]
    fn huge_leaves_accept_pat_and_ignored_high_bits_but_reject_reserved_address_bits() {
        let (mut image, state) = fixture();
        let request = Request {
            linear: 0x1234,
            access: Access::Read,
            user: true,
        };
        for (entry, word, expected) in [
            (0x2000, 0x7ff0000040001087, 0x40001234),
            (0x3000, 0x7ff0000000201087, 0x201234),
        ] {
            let old = image.physical_read(entry, 8).unwrap();
            image.physical_write(entry, 8, word).unwrap();
            assert_eq!(peek(&image, &state, request).unwrap().physical, expected);
            image.physical_write(entry, 8, word | (1 << 13)).unwrap();
            assert_eq!(
                peek(&image, &state, request),
                Err(Failure::Page(PageFault {
                    address: 0x1234,
                    access: Access::Read,
                    error_code: 13
                }))
            );
            image.physical_write(entry, 8, old).unwrap();
        }
    }

    #[test]
    fn family_specialization_preserves_literal_entry_access_traces_and_geometry() {
        fn trace<const EFFECTS: bool, const FETCH: bool>(
            state: &State,
            words: &[(u64, u64)],
            expected: Translation,
            accesses: &[(u64, bool)],
        ) {
            let mut words: std::collections::HashMap<_, _> = words.iter().copied().collect();
            let mut actual = Vec::new();
            let translated = walk_with::<EFFECTS, FETCH>(
                state,
                Request {
                    linear: 0x1234,
                    access: Access::Read,
                    user: true,
                },
                |address, width, accessed| {
                    actual.push((address, width, accessed));
                    let word = words.get_mut(&address).expect("unexpected table access");
                    if accessed {
                        *word |= 0x20;
                    }
                    Ok(Some(*word))
                },
            )
            .unwrap()
            .unwrap();
            assert_eq!(translated, expected);
            let expected_accesses: Vec<_> = accesses
                .iter()
                .map(|&(address, accessed)| (address, expected.entry_width, accessed))
                .collect();
            assert_eq!(actual, expected_accesses);
        }
        // Trace only the walker's entry-access boundary: an update is one callback,
        // not a claim that its backing preflight/current-word OR is one memory read.
        let cases = [
            (
                State {
                    cr3: 0x1000,
                    ..State::default()
                },
                vec![
                    (0x1000, 0x2007),
                    (0x2000, 0x3007),
                    (0x3000, 0x4007),
                    (0x4008, 0xa007),
                ],
                vec![
                    (0x1000, 0x2027),
                    (0x2000, 0x3027),
                    (0x3000, 0x4027),
                    (0x4008, 0xa027),
                ],
                Translation {
                    physical: 0xa234,
                    leaf: 0x4008,
                    dirty: true,
                    remaining: 0xdcc,
                    entry_width: 8,
                    entries: [0x1000, 0x2000, 0x3000, 0x4008],
                    count: 4,
                },
                vec![
                    (0x1000, false),
                    (0x2000, false),
                    (0x3000, false),
                    (0x4008, false),
                ],
                vec![
                    (0x1000, false),
                    (0x1000, true),
                    (0x2000, false),
                    (0x2000, true),
                    (0x3000, false),
                    (0x3000, true),
                    (0x4008, false),
                    (0x4008, true),
                ],
                vec![
                    (0x1000, false),
                    (0x1000, true),
                    (0x1000, false),
                    (0x2000, false),
                    (0x2000, true),
                    (0x1000, false),
                    (0x2000, false),
                    (0x3000, false),
                    (0x3000, true),
                    (0x1000, false),
                    (0x2000, false),
                    (0x3000, false),
                    (0x4008, false),
                    (0x4008, true),
                    (0x1000, false),
                    (0x2000, false),
                    (0x3000, false),
                    (0x4008, false),
                ],
            ),
            (
                State {
                    cr0: 0x80000033,
                    cr2: 0,
                    cr3: 0x1020,
                    cr4: 0x628,
                    efer: 0,
                    pdpte: Some([0x3001, 0, 0, 0]),
                },
                vec![(0x3000, 0x4007), (0x4008, 0xa007)],
                vec![(0x3000, 0x4027), (0x4008, 0xa027)],
                Translation {
                    physical: 0xa234,
                    leaf: 0x4008,
                    dirty: true,
                    remaining: 0xdcc,
                    entry_width: 8,
                    entries: [0x3000, 0x4008, 0, 0],
                    count: 2,
                },
                vec![(0x3000, false), (0x4008, false)],
                vec![
                    (0x3000, false),
                    (0x3000, true),
                    (0x4008, false),
                    (0x4008, true),
                ],
                vec![
                    (0x3000, false),
                    (0x3000, true),
                    (0x3000, false),
                    (0x4008, false),
                    (0x4008, true),
                    (0x3000, false),
                    (0x4008, false),
                ],
            ),
            (
                State {
                    cr0: 0x80000033,
                    cr2: 0,
                    cr3: 0x1000,
                    cr4: 0x608,
                    efer: 0,
                    pdpte: None,
                },
                vec![(0x1000, 0x4007), (0x4004, 0xa007)],
                vec![(0x1000, 0x4027), (0x4004, 0xa027)],
                Translation {
                    physical: 0xa234,
                    leaf: 0x4004,
                    dirty: true,
                    remaining: 0xdcc,
                    entry_width: 4,
                    entries: [0x1000, 0x4004, 0, 0],
                    count: 2,
                },
                vec![(0x1000, false), (0x4004, false)],
                vec![
                    (0x1000, false),
                    (0x1000, true),
                    (0x4004, false),
                    (0x4004, true),
                ],
                vec![
                    (0x1000, false),
                    (0x1000, true),
                    (0x1000, false),
                    (0x4004, false),
                    (0x4004, true),
                    (0x1000, false),
                    (0x4004, false),
                ],
            ),
            (
                State {
                    cr3: 0xdead000,
                    cr4: 0x620,
                    efer: 0x100,
                    ..State::reset()
                },
                vec![],
                vec![],
                Translation {
                    physical: 0x1234,
                    leaf: 0,
                    dirty: false,
                    remaining: 0xffffedcc,
                    entry_width: 0,
                    entries: [0; 4],
                    count: 0,
                },
                vec![],
                vec![],
                vec![],
            ),
        ];
        for (state, cold, warm, geometry, reads, updates, coherent) in cases {
            trace::<false, false>(&state, &cold, geometry, &reads);
            trace::<true, false>(&state, &cold, geometry, &updates);
            trace::<true, true>(&state, &cold, geometry, &coherent);
            trace::<false, false>(&state, &warm, geometry, &reads);
            trace::<true, false>(&state, &warm, geometry, &reads);
            trace::<true, true>(&state, &warm, geometry, &reads);
        }
    }

    #[test]
    fn actual_physical_walk_calls_have_literal_width_and_effect_counts() {
        fn image(words: &[(u64, u64)], width: usize, warm: bool, length: usize) -> Image {
            let mut bytes = vec![0; length];
            for &(address, word) in words {
                let word = word | if warm { 0x20 } else { 0 };
                bytes[address as usize..address as usize + width]
                    .copy_from_slice(&word.to_le_bytes()[..width]);
            }
            Image::physical_mapped(
                vec![("tables".into(), bytes)],
                vec![MappingInput {
                    base: 0,
                    backing: "tables".into(),
                    offset: 0,
                    length: length as u32,
                    permissions: Permissions {
                        read: true,
                        write: true,
                        execute: false,
                    },
                }],
                MemoryLimits {
                    max_backings: 1,
                    max_mappings: 1,
                    max_backing_bytes: length as u32,
                },
            )
            .unwrap()
        }
        // Counts are explicit Image read/read-bytes, write-check/check-bytes,
        // write/write-bytes calls in this owner, not full-engine instrumentation.
        // FETCH uses a no-op encoding-currentness callback. Payload/D work and
        // any nested embedding encoding checks are outside these measurements.
        let cases = [
            (
                State {
                    cr3: 0x1000,
                    ..State::default()
                },
                0x1234,
                vec![
                    (0x1000, 0x2007),
                    (0x2000, 0x3007),
                    (0x3000, 0x4007),
                    (0x4008, 0xa007),
                ],
                8,
                0xa234,
                [4, 32, 0, 0, 0, 0],
                [8, 64, 4, 32, 4, 32],
                [18, 144, 4, 32, 4, 32],
            ),
            (
                State {
                    cr0: 0x80000033,
                    cr2: 0,
                    cr3: 0x1020,
                    cr4: 0x628,
                    efer: 0,
                    pdpte: Some([0x3001, 0, 0, 0]),
                },
                0x1234,
                vec![(0x3000, 0x4007), (0x4008, 0xa007)],
                8,
                0xa234,
                [2, 16, 0, 0, 0, 0],
                [4, 32, 2, 16, 2, 16],
                [7, 56, 2, 16, 2, 16],
            ),
            (
                State {
                    cr0: 0x80000033,
                    cr2: 0,
                    cr3: 0x1000,
                    cr4: 0x608,
                    efer: 0,
                    pdpte: None,
                },
                0x1234,
                vec![(0x1000, 0x4007), (0x4004, 0xa007)],
                4,
                0xa234,
                [2, 8, 0, 0, 0, 0],
                [4, 16, 2, 8, 2, 8],
                [7, 28, 2, 8, 2, 8],
            ),
            (
                State {
                    cr0: 0x80000033,
                    cr2: 0,
                    cr3: 0x1000,
                    cr4: 0x618,
                    efer: 0,
                    pdpte: None,
                },
                0x400004,
                vec![(0x1004, 0x2087)],
                4,
                0x100000004,
                [1, 4, 0, 0, 0, 0],
                [2, 8, 1, 4, 1, 4],
                [3, 12, 1, 4, 1, 4],
            ),
            (
                State {
                    cr0: 0x80000033,
                    cr2: 0,
                    cr3: 0x1020,
                    cr4: 0x628,
                    efer: 0,
                    pdpte: Some([0x3001, 0, 0, 0]),
                },
                0x200004,
                vec![(0x3008, 0x400087)],
                8,
                0x400004,
                [1, 8, 0, 0, 0, 0],
                [2, 16, 1, 8, 1, 8],
                [3, 24, 1, 8, 1, 8],
            ),
            (
                State {
                    cr3: 0xdead000,
                    cr4: 0x620,
                    efer: 0x100,
                    ..State::reset()
                },
                0x1234,
                vec![],
                8,
                0x1234,
                [0; 6],
                [0; 6],
                [0; 6],
            ),
        ];
        for (state, linear, words, width, physical, warm, cold, coherent) in cases {
            let request = Request {
                linear,
                access: Access::Read,
                user: true,
            };
            let mut actual = image(&words, width, false, 0x6000);
            physical_counts::take();
            assert_eq!(peek(&actual, &state, request).unwrap().physical, physical);
            assert_eq!(
                physical_counts::take(),
                warm,
                "observational cold table reads"
            );
            assert_eq!(
                walk(&mut actual, &state, request).unwrap().physical,
                physical
            );
            assert_eq!(
                physical_counts::take(),
                cold,
                "actual current-word A effects"
            );
            assert_eq!(
                walk(&mut actual, &state, request).unwrap().physical,
                physical
            );
            assert_eq!(physical_counts::take(), warm, "warm walk skips A updates");
            assert_eq!(
                fetch_walk(&mut actual, &state, request, |_| true)
                    .unwrap()
                    .unwrap()
                    .physical,
                physical
            );
            assert_eq!(
                physical_counts::take(),
                warm,
                "warm FETCH skips hierarchy rereads"
            );
            let mut actual = image(&words, width, false, 0x6000);
            assert_eq!(
                fetch_walk(&mut actual, &state, request, |_| true)
                    .unwrap()
                    .unwrap()
                    .physical,
                physical
            );
            assert_eq!(
                physical_counts::take(),
                coherent,
                "cold FETCH includes hierarchy rereads"
            );
        }
        let quartet = [0x1001, 0xfffffffffffffffe, 0, 0x2001];
        let words: Vec<_> = quartet
            .into_iter()
            .enumerate()
            .map(|(slot, word)| (0x5fe0 + slot as u64 * 8, word))
            .collect();
        let state = State {
            cr3: 0x5fe0,
            ..State::reset()
        };
        let actual = image(&words, 8, false, 0x6000);
        assert_eq!(state.load_pdpte(&actual).unwrap(), quartet);
        assert_eq!(
            physical_counts::take(),
            [4, 32, 0, 0, 0, 0],
            "captured quartet has four exact reads and no A/D"
        );
    }
}

#[cfg(test)]
#[path = "legacy_tests.rs"]
mod legacy_tests;

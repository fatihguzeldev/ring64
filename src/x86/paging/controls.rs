use crate::x86::context::{ExecutionContext, Mode, Segment};

pub const EFER_MSR: u32 = 0xc0000080;
const CR0_FIXED: u64 = 0x80000033;
const CR0_WP: u64 = 1 << 16;
const CR0_NUMERIC: u64 = 0xe;
const CR4_NUMERIC: u64 = 0x600;
const CR3_ALLOWED: u64 = 0x000ffffffffff018;
const CR4_FIXED: u64 = 0x628;
const EFER_FIXED: u64 = 0x500;
const EFER_NXE: u64 = 1 << 11;
const EFER_SCE: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct State {
    pub cr0: u64,
    pub cr2: u64,
    pub cr3: u64,
    pub cr4: u64,
    pub efer: u64,
    pub pdpte: Option<[u64; 4]>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            cr0: CR0_FIXED,
            cr2: 0,
            cr3: 0,
            cr4: CR4_FIXED,
            efer: EFER_FIXED,
            pdpte: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlFailure {
    Undefined,
    GeneralProtection,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PdpteFailure {
    Physical {
        slot: u8,
        fault: crate::memory::Fault,
    },
    Reserved,
}

impl State {
    pub fn reset() -> Self {
        Self {
            cr0: 0x60000010,
            cr2: 0,
            cr3: 0,
            cr4: 0,
            efer: 0,
            pdpte: None,
        }
    }
    pub fn legacy_pae(self) -> bool {
        self.cr0 & (1 << 31) != 0 && self.cr4 & (1 << 5) != 0 && self.efer & (1 << 10) == 0
    }

    pub fn validate_physical(self, mode: Mode) -> Result<(), &'static str> {
        let pg = self.cr0 & 0x80000000 != 0;
        let pe = self.cr0 & 1 != 0;
        let lma = pg && self.efer & 0x100 != 0;
        let coherent_mode = match mode {
            Mode::Real => !pe && !pg,
            Mode::Protected | Mode::Virtual8086 => pe && !lma,
            Mode::Long64 | Mode::Compatibility => pe && lma,
        };
        if !coherent_mode
            || self.cr0 & !0xe001003f != 0
            || self.cr0 & 0x10 == 0
            || pg && !pe
            || self.cr0 & 0x60000000 == 0x20000000
            || self.cr3 & !0x000f_ffff_ffff_fff8 != 0
            || self.cr4 & !0x638 != 0
            || self.efer & !0xd01 != 0
            || (self.efer & 0x400 != 0) != lma
            || lma && self.cr4 & 0x20 == 0
        {
            return Err("physical controls require a consistent execution family");
        }
        if self.legacy_pae() != self.pdpte.is_some() {
            return Err("captured PDPTE quartet requires active legacy PAE");
        }
        if self
            .pdpte
            .is_some_and(|entries| !entries.into_iter().all(valid_pdpte))
        {
            return Err("reserved present captured PDPTE");
        }
        Ok(())
    }

    pub fn validate_physical_context(self, context: &ExecutionContext) -> Result<(), &'static str> {
        self.validate_physical(context.mode())?;
        if self.efer & 0x400 != 0
            && ((context.mode() == Mode::Long64) != context.attributes(Segment::Cs).long
                || context.mode() == Mode::Long64 && context.segment(Segment::Cs).default32
                || context.tr().valid && matches!(context.tr().attributes & 15, 1 | 3))
        {
            return Err("physical IA32e context has inconsistent loaded CS or task cache");
        }
        Ok(())
    }

    pub fn transition_context(
        self,
        candidate: Self,
        context: &ExecutionContext,
    ) -> Result<ExecutionContext, ControlFailure> {
        if self.efer & 0x400 == 0
            && candidate.efer & 0x400 != 0
            && (context.attributes(Segment::Cs).long
                || context.tr().valid && matches!(context.tr().attributes & 15, 1 | 3))
        {
            return Err(ControlFailure::GeneralProtection);
        }
        let mode = if candidate.cr0 & 1 == 0 {
            Mode::Real
        } else if candidate.efer & 0x400 != 0 {
            if context.attributes(Segment::Cs).long {
                Mode::Long64
            } else {
                Mode::Compatibility
            }
        } else if context.mode() == Mode::Virtual8086 {
            Mode::Virtual8086
        } else {
            Mode::Protected
        };
        let mut result = context.clone();
        result.set_mode_and_cpl(mode, if mode == Mode::Real { 0 } else { context.cpl() });
        Ok(result)
    }

    pub fn prepare_physical_cr_write_in_context(
        self,
        register: u8,
        value: u64,
        context: &ExecutionContext,
    ) -> Result<Self, ControlFailure> {
        // Loaded-CS/task activation restrictions are architectural invalidity,
        // so they precede refusal of otherwise-defined deferred facilities.
        if register == 0
            && self.efer & 0x400 == 0
            && self.efer & 0x100 != 0
            && value & 0x80000000 != 0
            && (context.attributes(Segment::Cs).long
                || context.tr().valid && matches!(context.tr().attributes & 15, 1 | 3))
        {
            return Err(ControlFailure::GeneralProtection);
        }
        self.prepare_physical_cr_write(register, value, context.mode())
    }

    pub fn prepare_physical_cr_write(
        self,
        register: u8,
        value: u64,
        mode: Mode,
    ) -> Result<Self, ControlFailure> {
        use ControlFailure::{GeneralProtection, Unsupported};
        let mut candidate = self;
        match register {
            0 => {
                if value >> 32 != 0 {
                    return Err(GeneralProtection);
                }
                let value = (value & 0xe005003f) | 0x10;
                if value & 0x80000001 == 0x80000000
                    || value & 0x60000000 == 0x20000000
                    || mode == Mode::Long64 && value & 0x80000000 == 0
                    || value & 0x80000000 != 0 && self.efer & 0x100 != 0 && self.cr4 & 0x20 == 0
                {
                    return Err(GeneralProtection);
                }
                if value & !0xe001003f != 0 {
                    return Err(Unsupported);
                }
                candidate.cr0 = value;
                candidate.efer = (self.efer & !0x400)
                    | if value & 0x80000000 != 0 && self.efer & 0x100 != 0 {
                        0x400
                    } else {
                        0
                    };
            }
            2 => candidate.cr2 = value,
            3 => {
                if self.efer & 0x400 != 0 {
                    candidate = self.prepare_cr_write(register, value, mode)?;
                } else {
                    candidate.cr3 = u64::from(value as u32)
                        & if self.cr4 & 0x20 != 0 {
                            0xffffffe0
                        } else {
                            0xfffff018
                        };
                }
            }
            4 => {
                let defined = 0x7fff | (0x3ff << 16) | (3 << 27) | (1 << 32);
                if value & !defined != 0
                    || self.efer & 0x400 != 0
                        && (value & 0x20 == 0 || (self.cr4 ^ value) & 0x1000 != 0)
                    || value & (1 << 17) != 0 && (self.efer & 0x400 == 0 || self.cr3 & 0xfff != 0)
                    || value & (1 << 23) != 0 && self.cr0 & CR0_WP == 0
                {
                    return Err(GeneralProtection);
                }
                if value & !0x638 != 0 {
                    return Err(Unsupported);
                }
                candidate.cr4 = value;
            }
            _ => return self.prepare_cr_write(register, value, mode),
        }
        if !candidate.legacy_pae() {
            candidate.pdpte = None;
        }
        Ok(candidate)
    }

    pub fn prepare_physical_efer_write(self, value: u64) -> Result<Self, ControlFailure> {
        if value & !0xd01 != 0 || self.cr0 & 0x80000000 != 0 && (self.efer ^ value) & 0x100 != 0 {
            return Err(ControlFailure::GeneralProtection);
        }
        let efer = (value & !0x400)
            | if self.cr0 & 0x80000000 != 0 && value & 0x100 != 0 {
                0x400
            } else {
                0
            };
        Ok(Self { efer, ..self })
    }

    pub fn needs_pdpte_reload(self, candidate: Self, register: u8) -> bool {
        candidate.legacy_pae()
            && match register {
                0 => (self.cr0 ^ candidate.cr0) & 0xe0000000 != 0,
                3 => true,
                4 => (self.cr4 ^ candidate.cr4) & 0x001000b0 != 0,
                _ => false,
            }
    }

    pub fn load_pdpte(self, image: &crate::memory::Image) -> Result<[u64; 4], PdpteFailure> {
        let mut entries = [0; 4];
        let root = self.cr3 & 0xffffffe0;
        for (slot, entry) in entries.iter_mut().enumerate() {
            *entry = image
                .physical_read(root + slot as u64 * 8, 8)
                .map_err(|fault| PdpteFailure::Physical {
                    slot: slot as u8,
                    fault,
                })?;
        }
        if !entries.into_iter().all(valid_pdpte) {
            return Err(PdpteFailure::Reserved);
        }
        Ok(entries)
    }
}

fn valid_pdpte(value: u64) -> bool {
    value & 1 == 0 || value & 0xfff00000000001e6 == 0
}

impl State {
    pub fn validate(self) -> Result<(), &'static str> {
        if self.pdpte.is_some()
            || self.cr0 & !(CR0_WP | CR0_NUMERIC) != CR0_FIXED & !CR0_NUMERIC
            || self.cr3 & !CR3_ALLOWED != 0
            || self.cr4 & !CR4_NUMERIC != CR4_FIXED & !CR4_NUMERIC
            || self.efer & !(EFER_NXE | EFER_SCE) != EFER_FIXED
        {
            Err("paging controls do not match the normalized IA32e profile")
        } else {
            Ok(())
        }
    }

    pub fn read_cr(self, register: u8) -> Result<u64, ControlFailure> {
        match register {
            0 => Ok(self.cr0),
            2 => Ok(self.cr2),
            3 => Ok(self.cr3),
            4 => Ok(self.cr4),
            8 => Err(ControlFailure::Unsupported),
            _ => Err(ControlFailure::Undefined),
        }
    }

    pub fn prepare_cr_write(
        self,
        register: u8,
        value: u64,
        mode: Mode,
    ) -> Result<Self, ControlFailure> {
        use ControlFailure::{GeneralProtection, Undefined, Unsupported};
        let mut candidate = self;
        match register {
            0 => {
                if value >> 32 != 0 {
                    return Err(GeneralProtection);
                }
                let value = (value & 0xe005003f) | 0x10;
                if value & 0x80000001 == 0x80000000
                    || value & 0x60000000 == 0x20000000
                    || matches!(mode, Mode::Long64) && value & 0x80000000 == 0
                {
                    return Err(GeneralProtection);
                }
                if value & !(CR0_WP | CR0_NUMERIC) != CR0_FIXED & !CR0_NUMERIC {
                    return Err(Unsupported);
                }
                candidate.cr0 = value;
            }
            2 => candidate.cr2 = value,
            3 => {
                if value & 0x9ff0000000000000 != 0 {
                    return Err(GeneralProtection);
                }
                if value & (3 << 61) != 0 {
                    return Err(Unsupported);
                }
                candidate.cr3 = value & CR3_ALLOWED;
            }
            4 => {
                let defined = 0x7fff | (0x3ff << 16) | (3 << 27) | (1 << 32);
                if value & !defined != 0
                    || value & (1 << 5) == 0
                    || value & (1 << 12) != 0
                    || value & (1 << 17) != 0 && self.cr3 & 0xfff != 0
                    || value & (1 << 23) != 0 && self.cr0 & CR0_WP == 0
                {
                    return Err(GeneralProtection);
                }
                if value & !CR4_NUMERIC != CR4_FIXED & !CR4_NUMERIC {
                    return Err(Unsupported);
                }
                candidate.cr4 = value;
            }
            8 => {
                return Err(if value & !15 != 0 {
                    GeneralProtection
                } else {
                    Unsupported
                });
            }
            _ => return Err(Undefined),
        }
        Ok(candidate)
    }

    pub fn prepare_efer_write(self, value: u64) -> Result<Self, ControlFailure> {
        if value & !0xd01 != 0 || value & (1 << 8) == 0 {
            return Err(ControlFailure::GeneralProtection);
        }
        Ok(Self {
            efer: (value & (EFER_NXE | EFER_SCE)) | EFER_FIXED,
            ..self
        })
    }

    pub fn read_msr(self, index: u32) -> Result<u64, ControlFailure> {
        if index == EFER_MSR {
            Ok(self.efer)
        } else {
            Err(ControlFailure::Unsupported)
        }
    }

    pub fn prepare_msr_write(self, index: u32, value: u64) -> Result<Self, ControlFailure> {
        if index == EFER_MSR {
            self.prepare_efer_write(value)
        } else {
            Err(ControlFailure::Unsupported)
        }
    }

    pub fn numeric_controls(self) -> u8 {
        ((self.cr0 >> 1) & 7) as u8 | (((self.cr4 >> 9) & 3) as u8) << 3
    }

    pub fn translation_changed(self, other: Self) -> bool {
        (
            self.cr0 & !CR0_NUMERIC,
            self.cr3,
            self.cr4 & !CR4_NUMERIC,
            self.efer & EFER_NXE,
            self.pdpte,
        ) != (
            other.cr0 & !CR0_NUMERIC,
            other.cr3,
            other.cr4 & !CR4_NUMERIC,
            other.efer & EFER_NXE,
            other.pdpte,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ControlFailure::{GeneralProtection, Undefined, Unsupported};

    fn bank() -> State {
        State {
            cr0: 0x80000033,
            cr2: 0xffffffffffffffff,
            cr3: 0x0008000000003018,
            cr4: 0x628,
            efer: 0x500,
            pdpte: None,
        }
    }

    #[test]
    fn all_numeric_enable_images_are_valid_and_do_not_change_translation() {
        for bits in 0u64..32 {
            let state = State {
                cr0: 0x80000031 | (bits & 7) << 1,
                cr4: 0x28 | (bits >> 3) << 9,
                ..bank()
            };
            assert_eq!(state.validate(), Ok(()), "{bits}");
            assert!(!bank().translation_changed(state), "{bits}");
            assert_eq!(
                bank()
                    .prepare_cr_write(0, state.cr0, Mode::Long64)
                    .unwrap()
                    .cr0,
                state.cr0
            );
            assert_eq!(
                bank()
                    .prepare_cr_write(4, state.cr4, Mode::Long64)
                    .unwrap()
                    .cr4,
                state.cr4
            );
        }
    }

    #[test]
    fn imported_bank_is_complete_normalized_and_does_not_probe_a_root() {
        assert_eq!(
            State::default(),
            State {
                cr2: 0,
                cr3: 0,
                ..bank()
            }
        );
        assert_eq!(bank().validate(), Ok(()));
        assert_eq!(
            State {
                cr0: 0x80010033,
                efer: 0xd00,
                ..bank()
            }
            .validate(),
            Ok(())
        );
        for field in 0..5 {
            let mut bad = bank();
            match field {
                0 => bad.cr0 |= 1 << 6,
                1 => bad.cr0 &= !1,
                2 => bad.cr3 |= 1,
                3 => bad.cr4 |= 1 << 7,
                4 => bad.efer |= 1 << 1,
                _ => unreachable!(),
            }
            assert!(bad.validate().is_err(), "field {field}");
        }
        for bit in 52..64 {
            assert!(
                State {
                    cr3: 1 << bit,
                    ..bank()
                }
                .validate()
                .is_err()
            );
        }
    }

    #[test]
    fn cr_register_legality_and_raw_cr2_are_owned_independently() {
        let state = bank();
        for (register, expected) in [
            (0, state.cr0),
            (2, state.cr2),
            (3, state.cr3),
            (4, state.cr4),
        ] {
            assert_eq!(state.read_cr(register), Ok(expected));
        }
        for register in [1, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15] {
            assert_eq!(state.read_cr(register), Err(Undefined));
            assert_eq!(
                state.prepare_cr_write(register, 0, Mode::Long64),
                Err(Undefined)
            );
        }
        assert_eq!(state.read_cr(8), Err(Unsupported));
        assert_eq!(state.prepare_cr_write(8, 0, Mode::Long64), Err(Unsupported));
        let changed = state
            .prepare_cr_write(2, 0x8000000000000000, Mode::Long64)
            .unwrap();
        assert_eq!(
            changed,
            State {
                cr2: 0x8000000000000000,
                ..state
            }
        );
        assert!(!state.translation_changed(changed));
    }

    #[test]
    fn cr0_ignores_low_reserved_bits_but_checks_values_before_profile_support() {
        let state = bank();
        assert_eq!(
            state.prepare_cr_write(0, 0x80000023 | (1 << 6), Mode::Long64),
            Ok(state)
        );
        let wp = state.prepare_cr_write(0, 0x80010033, Mode::Long64).unwrap();
        assert_eq!(wp.cr0, 0x80010033);
        assert!(state.translation_changed(wp));
        for value in [0x180000033, 0x80000032, 0xa0000033, 0x33] {
            assert_eq!(
                state.prepare_cr_write(0, value, Mode::Long64),
                Err(GeneralProtection)
            );
        }
        assert_eq!(
            state.prepare_cr_write(0, 0x33, Mode::Compatibility),
            Err(Unsupported)
        );
        assert_eq!(
            state.prepare_cr_write(8, 16, Mode::Long64),
            Err(GeneralProtection)
        );
        for value in [0x80000013, 0x80040033, 0xe0000033] {
            assert_eq!(
                state.prepare_cr_write(0, value, Mode::Long64),
                Err(Unsupported),
                "{value:x}"
            );
        }
    }

    #[test]
    fn cr3_ignored_low_bits_normalize_without_losing_root_or_cache_bits() {
        let state = bank();
        let changed = state
            .prepare_cr_write(3, 0x000fffffffffffff, Mode::Long64)
            .unwrap();
        assert_eq!(changed.cr3, 0x000ffffffffff018);
        for bit in 52..=60 {
            assert_eq!(
                state.prepare_cr_write(3, (1 << bit) | (1 << 61), Mode::Long64),
                Err(GeneralProtection)
            );
        }
        assert_eq!(
            state.prepare_cr_write(3, 1 << 63, Mode::Long64),
            Err(GeneralProtection)
        );
        for bit in [61, 62] {
            assert_eq!(
                state.prepare_cr_write(3, 1 << bit, Mode::Long64),
                Err(Unsupported)
            );
        }
        assert_eq!(
            state.prepare_cr_write(3, state.cr3, Mode::Long64),
            Ok(state)
        );
    }

    #[test]
    fn cr4_reserved_and_architectural_transitions_precede_deferred_features() {
        let state = bank();
        assert_eq!(state.prepare_cr_write(4, 0x628, Mode::Long64), Ok(state));
        for value in [0x608, 0x1628, 0x20628, 0x800628] {
            assert_eq!(
                state.prepare_cr_write(4, value, Mode::Long64),
                Err(GeneralProtection),
                "{value:x}"
            );
        }
        for bit in [15, 26, 29, 30, 31, 33, 63] {
            assert_eq!(
                state.prepare_cr_write(4, 0x628 | (1 << bit), Mode::Long64),
                Err(GeneralProtection)
            );
        }
        let aligned = State {
            cr0: 0x80010033,
            cr3: 0x3000,
            ..state
        };
        for bit in [0, 7, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 32] {
            assert_eq!(
                aligned.prepare_cr_write(4, 0x628 | (1 << bit), Mode::Long64),
                Err(Unsupported),
                "bit {bit}"
            );
        }
        assert_eq!(
            state.prepare_cr_write(4, 0x620, Mode::Long64),
            Err(Unsupported)
        );
    }

    #[test]
    fn efer_lma_is_read_only_lme_cannot_change_and_nxe_is_live_authority() {
        let state = bank();
        assert_eq!(state.prepare_efer_write(0x100), Ok(state));
        let nxe = state.prepare_efer_write(0x900).unwrap();
        assert_eq!(nxe.efer, 0xd00);
        assert!(state.translation_changed(nxe));
        assert_eq!(nxe.prepare_efer_write(0x500), Ok(state));
        for value in [0x400, 0, 0x1500, 0x501 | (1 << 63)] {
            assert_eq!(
                state.prepare_efer_write(value),
                Err(GeneralProtection),
                "{value:x}"
            );
        }
        assert_eq!(
            state.prepare_efer_write(0x501),
            Ok(State {
                efer: 0x501,
                ..state
            })
        );
        assert_eq!(state, bank());
    }

    #[test]
    fn efer_sce_is_live_normalized_state_without_changing_other_controls() {
        for efer in [0x500, 0x501, 0xd00, 0xd01] {
            let state = State { efer, ..bank() };
            assert_eq!(state.validate(), Ok(()));
            assert_eq!(state.read_msr(0xc0000080), Ok(efer));
            for input in [0x100, 0x101, 0x900, 0x901, 0x500, 0x501, 0xd00, 0xd01] {
                let next = state.prepare_efer_write(input).unwrap();
                assert_eq!(
                    next,
                    State {
                        efer: (input & 0x801) | 0x500,
                        ..state
                    }
                );
                assert_eq!(next.cr2, state.cr2);
            }
        }
    }

    #[test]
    fn sce_only_updates_do_not_change_paging_authority_but_nxe_and_cr_changes_do() {
        let state = bank();
        assert!(!state.translation_changed(State {
            efer: 0x501,
            ..state
        }));
        let nxe = State {
            efer: 0xd00,
            ..state
        };
        assert!(!nxe.translation_changed(State { efer: 0xd01, ..nxe }));
        assert!(state.translation_changed(nxe));
        assert!(state.translation_changed(State {
            cr0: 0x80010033,
            ..state
        }));
        assert!(state.translation_changed(State {
            cr3: 0x5000,
            ..state
        }));
        assert!(state.translation_changed(State {
            cr4: 0x620,
            ..state
        }));
        assert!(!state.translation_changed(State {
            cr2: 0x400000,
            ..state
        }));
    }

    #[test]
    fn efer_is_the_selected_msr_and_other_indices_remain_private() {
        let state = bank();
        assert_eq!(state.read_msr(0xc0000080), Ok(0x500));
        assert_eq!(
            state.prepare_msr_write(0xc0000080, 0xd00),
            Ok(State {
                efer: 0xd00,
                ..state
            })
        );
        for index in [0, 0x174, 0xc0000081, u32::MAX] {
            assert_eq!(state.read_msr(index), Err(Unsupported));
            assert_eq!(state.prepare_msr_write(index, u64::MAX), Err(Unsupported));
        }
    }
}

#[cfg(test)]
#[path = "legacy_controls_tests.rs"]
mod legacy_tests;

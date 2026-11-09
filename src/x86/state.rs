#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub registers: [u64; 16],
    pub flags: u64,
    pub rip: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            registers: [0; 16],
            flags: 2,
            rip: 0,
        }
    }
}

impl State {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.flags & !super::flags::IMPORTED_MASK != 0 {
            return Err("flags contain reserved bits or the mode-owned VM bit");
        }
        if self.flags & 2 == 0 {
            return Err("flags must contain reserved bit one");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::State;

    #[test]
    fn system_flags_are_importable_without_a_second_vm_authority() {
        for flags in [0x102, 0x202, 0x1002, 0x3d7fd7] {
            assert_eq!(
                State {
                    flags,
                    ..State::default()
                }
                .validate(),
                Ok(())
            );
        }
        for flags in [0x20002, 0x8002, 0x400002] {
            assert!(
                State {
                    flags,
                    ..State::default()
                }
                .validate()
                .is_err()
            );
        }
    }

    #[test]
    fn imported_state_admits_raw_register_and_instruction_pointer_bits() {
        let state = State {
            registers: [u64::MAX; 16],
            flags: 0x8d7,
            rip: 0x0000_8000_0000_0000,
        };
        assert_eq!(State::default().flags, 2);
        assert_eq!(State::default().validate(), Ok(()));
        assert_eq!(state.validate(), Ok(()));
    }

    #[test]
    fn imported_flags_require_bit_one_and_exclude_vm_and_reserved_bits() {
        for flags in [0, 1, 0x8d5, 0xcd5, 0x8002, 0x20002, u64::MAX] {
            assert!(
                State {
                    flags,
                    ..State::default()
                }
                .validate()
                .is_err(),
                "{flags:x}"
            );
        }
        for flags in [2, 3, 0x46, 0x97, 0x8d7, 0x402, 0x497, 0xcd7] {
            assert_eq!(
                State {
                    flags,
                    ..State::default()
                }
                .validate(),
                Ok(())
            );
        }
    }
}

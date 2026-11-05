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
        if self.flags & !0x8d7 != 0 {
            return Err("flags contain bits outside the imported arithmetic context");
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
    fn imported_flags_require_bit_one_and_exclude_controls_and_reserved_bits() {
        for flags in [0, 1, 0x8d5, 0x202, 0x402, u64::MAX] {
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
        for flags in [2, 3, 0x46, 0x97, 0x8d7] {
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

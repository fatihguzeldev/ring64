use super::ProtectionKind;

#[derive(Clone, Copy, Debug)]
pub(super) struct Descriptor {
    pub base: u32,
    pub limit: u32,
    pub access: u8,
    pub flags: u8,
}

impl Descriptor {
    pub fn decode(raw: u64) -> Self {
        let raw_limit = (raw as u32 & 0xffff) | ((raw >> 32) as u32 & 0xf0000);
        let flags = ((raw >> 52) & 15) as u8;
        Self {
            base: ((raw >> 16) as u32 & 0xffffff) | ((raw >> 32) as u32 & 0xff000000),
            limit: if flags & 8 != 0 {
                (raw_limit << 12) | 0xfff
            } else {
                raw_limit
            },
            access: (raw >> 40) as u8,
            flags,
        }
    }

    pub fn rights(self) -> u32 {
        u32::from(self.access) << 8 | u32::from(self.flags) << 20
    }

    pub fn query(self, kind: ProtectionKind, ia32e: bool, cpl: u8, rpl: u8) -> bool {
        let allowed = if self.system() {
            let types = match (kind, ia32e) {
                (ProtectionKind::Lar, false) => 0x1a3e,
                (ProtectionKind::Lar, true) => 0x1a04,
                (ProtectionKind::Lsl, false) => 0x0a0e,
                (ProtectionKind::Lsl, true) => 0x0a04,
                _ => 0,
            };
            types & (1 << (self.access & 15)) != 0
        } else {
            match kind {
                ProtectionKind::Lar | ProtectionKind::Lsl => true,
                ProtectionKind::Verr => self.readable(),
                ProtectionKind::Verw => self.writable(),
                _ => false,
            }
        };
        allowed && (self.conforming() || cpl <= self.dpl() && rpl <= self.dpl())
    }

    pub fn system(self) -> bool {
        self.access & 0x10 == 0
    }
    pub fn code(self) -> bool {
        !self.system() && self.access & 8 != 0
    }
    pub fn readable(self) -> bool {
        !self.system() && (!self.code() || self.access & 2 != 0)
    }
    pub fn writable(self) -> bool {
        !self.system() && !self.code() && self.access & 2 != 0
    }
    pub fn conforming(self) -> bool {
        self.code() && self.access & 4 != 0
    }
    pub fn dpl(self) -> u8 {
        (self.access >> 5) & 3
    }
    pub fn present(self) -> bool {
        self.access & 0x80 != 0
    }
    pub fn accessed(self) -> bool {
        self.access & 1 != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_split_fields_distinguish_limit_nibble_from_access_rights() {
        let descriptor = Descriptor::decode(0x12ca_9a34_0000_3456);
        assert_eq!(descriptor.base, 0x1234_0000);
        assert_eq!(descriptor.limit, 0xa345_6fff);
        assert_eq!(descriptor.access, 0x9a);
        assert_eq!(descriptor.flags, 0xc);
        assert_eq!(descriptor.rights(), 0x00c0_9a00);
        assert_eq!(descriptor.rights() as u16, 0x9a00);
        assert_eq!(descriptor.limit as u16, 0x6fff);
    }

    #[test]
    fn system_type_query_tables_and_privilege_ignore_presence() {
        for ia32e in [false, true] {
            let lar: &[u8] = if ia32e {
                &[2, 9, 11, 12]
            } else {
                &[1, 2, 3, 4, 5, 9, 11, 12]
            };
            let lsl: &[u8] = if ia32e {
                &[2, 9, 11]
            } else {
                &[1, 2, 3, 9, 11]
            };
            for kind in [
                ProtectionKind::Lar,
                ProtectionKind::Lsl,
                ProtectionKind::Verr,
                ProtectionKind::Verw,
            ] {
                for ty in 0..16u8 {
                    for dpl in 0..4u8 {
                        for cpl in 0..4u8 {
                            for rpl in 0..4u8 {
                                for present in [0, 0x80] {
                                    let d = Descriptor::decode(
                                        u64::from(present | dpl << 5 | ty) << 40,
                                    );
                                    let types = match kind {
                                        ProtectionKind::Lar => lar,
                                        ProtectionKind::Lsl => lsl,
                                        _ => &[],
                                    };
                                    let expected = types.contains(&ty) && cpl <= dpl && rpl <= dpl;
                                    assert_eq!(
                                        d.query(kind, ia32e, cpl, rpl),
                                        expected,
                                        "{kind:?} IA32e={ia32e} type={ty:x} DPL={dpl} CPL={cpl} RPL={rpl} P={present}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn code_and_data_queries_use_conforming_exemption_and_instruction_permissions() {
        for kind in [
            ProtectionKind::Lar,
            ProtectionKind::Lsl,
            ProtectionKind::Verr,
            ProtectionKind::Verw,
        ] {
            for ty in 0..16u8 {
                for dpl in 0..4u8 {
                    for cpl in 0..4u8 {
                        for rpl in 0..4u8 {
                            for present in [0, 0x80] {
                                let d = Descriptor::decode(
                                    u64::from(present | dpl << 5 | 0x10 | ty) << 40,
                                );
                                let permitted = match kind {
                                    ProtectionKind::Verr => ![8, 9, 12, 13].contains(&ty),
                                    ProtectionKind::Verw => [2, 3, 6, 7].contains(&ty),
                                    _ => true,
                                };
                                let visible =
                                    [12, 13, 14, 15].contains(&ty) || cpl <= dpl && rpl <= dpl;
                                assert_eq!(
                                    d.query(kind, true, cpl, rpl),
                                    permitted && visible,
                                    "{kind:?} type={ty:x} DPL={dpl} CPL={cpl} RPL={rpl} P={present}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

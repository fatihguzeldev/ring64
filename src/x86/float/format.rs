use super::Format;

impl Format {
    pub(super) fn bits(self) -> u32 {
        if self == Self::F32 { 32 } else { 64 }
    }
    pub(super) fn fraction(self) -> u32 {
        if self == Self::F32 { 23 } else { 52 }
    }
    pub(super) fn exponent_bits(self) -> u32 {
        if self == Self::F32 { 8 } else { 11 }
    }
    pub(super) fn mask(self) -> u64 {
        if self == Self::F32 {
            u32::MAX as u64
        } else {
            u64::MAX
        }
    }
    pub(super) fn sign(self) -> u64 {
        1 << (self.bits() - 1)
    }
    pub(super) fn infinity(self) -> u64 {
        ((1 << self.exponent_bits()) - 1) << self.fraction()
    }
    pub(super) fn fraction_mask(self) -> u64 {
        (1 << self.fraction()) - 1
    }
    pub(super) fn quiet(self) -> u64 {
        1 << (self.fraction() - 1)
    }
    pub(super) fn nan(self, value: u64) -> bool {
        value & self.infinity() == self.infinity() && value & self.fraction_mask() != 0
    }
    pub(super) fn snan(self, value: u64) -> bool {
        self.nan(value) && value & self.quiet() == 0
    }
    pub(super) fn infinite(self, value: u64) -> bool {
        value & !self.sign() == self.infinity()
    }
    pub(super) fn zero(self, value: u64) -> bool {
        value & !self.sign() == 0
    }
    pub(super) fn denormal(self, value: u64) -> bool {
        value & self.infinity() == 0 && value & self.fraction_mask() != 0
    }
    pub(super) fn indefinite(self) -> u64 {
        self.sign() | self.infinity() | self.quiet()
    }
    pub(super) fn opposite(self) -> Self {
        if self == Self::F32 {
            Self::F64
        } else {
            Self::F32
        }
    }
    pub(super) fn daz(self, value: u64, enabled: bool) -> u64 {
        if enabled && self.denormal(value) {
            value & self.sign()
        } else {
            value
        }
    }
    pub(super) fn convert_nan(self, value: u64) -> u64 {
        let target = self.opposite();
        let fraction = if self == Self::F32 {
            (value & self.fraction_mask()) << 29
        } else {
            (value & self.fraction_mask()) >> 29
        };
        let sign = if value & self.sign() != 0 {
            target.sign()
        } else {
            0
        };
        sign | target.infinity() | fraction | target.quiet()
    }
}

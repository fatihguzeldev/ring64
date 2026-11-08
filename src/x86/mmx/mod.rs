use super::float;
use super::instruction::{VectorBinary, VectorShift, Width};
use super::x87;

#[cfg(test)]
mod boundary_tests;
mod integer;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Kind {
    Move,
    Store,
    FromGpr,
    ToGpr,
    FromXmm,
    ToXmm,
    Binary(VectorBinary),
    Shift(VectorShift),
    Shuffle,
    InsertWord,
    ExtractWord,
    Mask,
    #[default]
    Empty,
    PiToPs,
    PiToPd,
    PsToPi,
    PdToPi,
    TruncPsToPi,
    TruncPdToPi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Op {
    pub kind: Kind,
    pub dst: u8,
    pub src: u8,
    pub memory: bool,
    pub wide: bool,
    pub immediate: u8,
    pub immediate_count: bool,
}

impl Op {
    pub fn encode(self) -> u32 {
        u32::from(code(self.kind).expect("unsupported MMX operation"))
            | (u32::from(self.dst) << 8)
            | (u32::from(self.src) << 12)
            | ((self.memory as u32) << 16)
            | ((self.wide as u32) << 17)
            | ((self.immediate_count as u32) << 18)
            | (u32::from(self.immediate) << 19)
    }

    pub fn try_decode(encoded: u32) -> Option<Self> {
        if encoded >> 27 != 0 {
            return None;
        }
        let op = Self {
            kind: kind(encoded as u8)?,
            dst: ((encoded >> 8) & 15) as u8,
            src: ((encoded >> 12) & 15) as u8,
            memory: encoded & (1 << 16) != 0,
            wide: encoded & (1 << 17) != 0,
            immediate_count: encoded & (1 << 18) != 0,
            immediate: (encoded >> 19) as u8,
        };
        op.well_formed().then_some(op)
    }

    fn well_formed(self) -> bool {
        use Kind::*;
        let mmx_source = self.src < 8 && (!self.memory || self.src == 0);
        let external_source = self.src < 16 && (!self.memory || self.src == 0);
        if self.wide && !matches!(self.kind, FromGpr | ToGpr | Store) {
            return false;
        }
        if self.immediate_count && !matches!(self.kind, Shift(_)) {
            return false;
        }
        if self.immediate != 0
            && !matches!(self.kind, Shuffle | InsertWord | ExtractWord)
            && !self.immediate_count
        {
            return false;
        }
        match self.kind {
            Move | Binary(_) | Shuffle => self.dst < 8 && mmx_source,
            Store => self.memory && self.dst == 0 && self.src < 8,
            FromGpr | InsertWord => self.dst < 8 && external_source,
            ToGpr => !self.memory && self.src < 8 && self.dst < 16,
            FromXmm => !self.memory && self.dst < 8 && self.src < 16,
            ToXmm | PiToPs | PiToPd => {
                self.dst < 16 && mmx_source && (self.kind != ToXmm || !self.memory)
            }
            ExtractWord | Mask => !self.memory && self.dst < 16 && self.src < 8,
            Shift(_) => {
                self.dst < 8
                    && if self.immediate_count {
                        !self.memory && self.src == 0
                    } else {
                        mmx_source
                    }
            }
            Empty => !self.memory && self.dst == 0 && self.src == 0,
            PsToPi | PdToPi | TruncPsToPi | TruncPdToPi => self.dst < 8 && external_source,
        }
    }

    pub fn memory_bytes(self) -> u32 {
        if !self.memory {
            return 0;
        }
        match self.kind {
            Kind::FromGpr | Kind::Store => {
                if self.wide {
                    8
                } else {
                    4
                }
            }
            Kind::InsertWord => 2,
            Kind::PdToPi | Kind::TruncPdToPi => 16,
            _ => 8,
        }
    }

    pub fn is_store(self) -> bool {
        self.kind == Kind::Store
    }

    pub fn checks_pending(self) -> bool {
        !(self.kind == Kind::PiToPd && self.memory)
    }

    pub fn source_gpr(self) -> Option<u8> {
        (!self.memory && matches!(self.kind, Kind::FromGpr | Kind::InsertWord)).then_some(self.src)
    }

    pub fn source_xmm(self) -> Option<u8> {
        (!self.memory
            && matches!(
                self.kind,
                Kind::FromXmm | Kind::PsToPi | Kind::PdToPi | Kind::TruncPsToPi | Kind::TruncPdToPi
            ))
        .then_some(self.src)
    }

    pub fn destination_gpr(self) -> Option<u8> {
        (!self.memory && matches!(self.kind, Kind::ToGpr | Kind::ExtractWord | Kind::Mask))
            .then_some(self.dst)
    }

    pub fn destination_xmm(self) -> Option<u8> {
        matches!(self.kind, Kind::ToXmm | Kind::PiToPs | Kind::PiToPd).then_some(self.dst)
    }
}

fn code(kind: Kind) -> Option<u8> {
    use Kind::*;
    use VectorBinary as B;
    use VectorShift as S;
    use Width::*;
    Some(match kind {
        Move => 0x6f,
        Store => 0x7f,
        FromGpr => 0x6e,
        ToGpr => 0x7e,
        FromXmm => 1,
        ToXmm => 2,
        Empty => 0x77,
        Shuffle => 0x70,
        InsertWord => 0xc4,
        ExtractWord => 0xc5,
        Mask => 0xd7,
        PiToPs => 0x10,
        PiToPd => 0x11,
        PsToPi => 0x12,
        PdToPi => 0x13,
        TruncPsToPi => 0x14,
        TruncPdToPi => 0x15,
        Binary(b) => match b {
            B::And => 0xdb,
            B::AndNot => 0xdf,
            B::Or => 0xeb,
            B::Xor => 0xef,
            B::Add(W8) => 0xfc,
            B::Add(W16) => 0xfd,
            B::Add(W32) => 0xfe,
            B::Add(W64) => 0xd4,
            B::Sub(W8) => 0xf8,
            B::Sub(W16) => 0xf9,
            B::Sub(W32) => 0xfa,
            B::Sub(W64) => 0xfb,
            B::SignedSaturatingAdd(W8) => 0xec,
            B::SignedSaturatingAdd(W16) => 0xed,
            B::UnsignedSaturatingAdd(W8) => 0xdc,
            B::UnsignedSaturatingAdd(W16) => 0xdd,
            B::SignedSaturatingSub(W8) => 0xe8,
            B::SignedSaturatingSub(W16) => 0xe9,
            B::UnsignedSaturatingSub(W8) => 0xd8,
            B::UnsignedSaturatingSub(W16) => 0xd9,
            B::CompareEqual(W8) => 0x74,
            B::CompareEqual(W16) => 0x75,
            B::CompareEqual(W32) => 0x76,
            B::CompareGreater(W8) => 0x64,
            B::CompareGreater(W16) => 0x65,
            B::CompareGreater(W32) => 0x66,
            B::MinUnsignedByte => 0xda,
            B::MaxUnsignedByte => 0xde,
            B::MinSignedWord => 0xea,
            B::MaxSignedWord => 0xee,
            B::Average(W8) => 0xe0,
            B::Average(W16) => 0xe3,
            B::MulLowWord => 0xd5,
            B::MulHighWord { signed: true } => 0xe5,
            B::MulHighWord { signed: false } => 0xe4,
            B::MulUnsignedDword => 0xf4,
            B::MaddSignedWord => 0xf5,
            B::SumAbsoluteByteDifferences => 0xf6,
            B::PackSigned(W16) => 0x63,
            B::PackSigned(W32) => 0x6b,
            B::PackUnsignedWord => 0x67,
            B::UnpackLow(W8) => 0x60,
            B::UnpackLow(W16) => 0x61,
            B::UnpackLow(W32) => 0x62,
            B::UnpackHigh(W8) => 0x68,
            B::UnpackHigh(W16) => 0x69,
            B::UnpackHigh(W32) => 0x6a,
            _ => return None,
        },
        Shift(s) => match s {
            S::Right(W16) => 0xd1,
            S::Right(W32) => 0xd2,
            S::Right(W64) => 0xd3,
            S::ArithmeticRight(W16) => 0xe1,
            S::ArithmeticRight(W32) => 0xe2,
            S::Left(W16) => 0xf1,
            S::Left(W32) => 0xf2,
            S::Left(W64) => 0xf3,
            _ => return None,
        },
    })
}

fn kind(code: u8) -> Option<Kind> {
    use Kind::*;
    use VectorBinary as B;
    use VectorShift as S;
    use Width::*;
    Some(match code {
        0x6f => Move,
        0x7f => Store,
        0x6e => FromGpr,
        0x7e => ToGpr,
        1 => FromXmm,
        2 => ToXmm,
        0x77 => Empty,
        0x70 => Shuffle,
        0xc4 => InsertWord,
        0xc5 => ExtractWord,
        0xd7 => Mask,
        0x10 => PiToPs,
        0x11 => PiToPd,
        0x12 => PsToPi,
        0x13 => PdToPi,
        0x14 => TruncPsToPi,
        0x15 => TruncPdToPi,
        0xdb => Binary(B::And),
        0xdf => Binary(B::AndNot),
        0xeb => Binary(B::Or),
        0xef => Binary(B::Xor),
        0xfc => Binary(B::Add(W8)),
        0xfd => Binary(B::Add(W16)),
        0xfe => Binary(B::Add(W32)),
        0xd4 => Binary(B::Add(W64)),
        0xf8 => Binary(B::Sub(W8)),
        0xf9 => Binary(B::Sub(W16)),
        0xfa => Binary(B::Sub(W32)),
        0xfb => Binary(B::Sub(W64)),
        0xec => Binary(B::SignedSaturatingAdd(W8)),
        0xed => Binary(B::SignedSaturatingAdd(W16)),
        0xdc => Binary(B::UnsignedSaturatingAdd(W8)),
        0xdd => Binary(B::UnsignedSaturatingAdd(W16)),
        0xe8 => Binary(B::SignedSaturatingSub(W8)),
        0xe9 => Binary(B::SignedSaturatingSub(W16)),
        0xd8 => Binary(B::UnsignedSaturatingSub(W8)),
        0xd9 => Binary(B::UnsignedSaturatingSub(W16)),
        0x74 => Binary(B::CompareEqual(W8)),
        0x75 => Binary(B::CompareEqual(W16)),
        0x76 => Binary(B::CompareEqual(W32)),
        0x64 => Binary(B::CompareGreater(W8)),
        0x65 => Binary(B::CompareGreater(W16)),
        0x66 => Binary(B::CompareGreater(W32)),
        0xda => Binary(B::MinUnsignedByte),
        0xde => Binary(B::MaxUnsignedByte),
        0xea => Binary(B::MinSignedWord),
        0xee => Binary(B::MaxSignedWord),
        0xe0 => Binary(B::Average(W8)),
        0xe3 => Binary(B::Average(W16)),
        0xd5 => Binary(B::MulLowWord),
        0xe5 => Binary(B::MulHighWord { signed: true }),
        0xe4 => Binary(B::MulHighWord { signed: false }),
        0xf4 => Binary(B::MulUnsignedDword),
        0xf5 => Binary(B::MaddSignedWord),
        0xf6 => Binary(B::SumAbsoluteByteDifferences),
        0x63 => Binary(B::PackSigned(W16)),
        0x6b => Binary(B::PackSigned(W32)),
        0x67 => Binary(B::PackUnsignedWord),
        0x60 => Binary(B::UnpackLow(W8)),
        0x61 => Binary(B::UnpackLow(W16)),
        0x62 => Binary(B::UnpackLow(W32)),
        0x68 => Binary(B::UnpackHigh(W8)),
        0x69 => Binary(B::UnpackHigh(W16)),
        0x6a => Binary(B::UnpackHigh(W32)),
        0xd1 => Shift(S::Right(W16)),
        0xd2 => Shift(S::Right(W32)),
        0xd3 => Shift(S::Right(W64)),
        0xe1 => Shift(S::ArithmeticRight(W16)),
        0xe2 => Shift(S::ArithmeticRight(W32)),
        0xf1 => Shift(S::Left(W16)),
        0xf2 => Shift(S::Left(W32)),
        0xf3 => Shift(S::Left(W64)),
        _ => return None,
    })
}

pub fn eval(
    state: &mut x87::State,
    op: Op,
    input: u128,
    xmm_destination: u128,
    mxcsr: u32,
) -> float::Outcome {
    use Kind::*;
    debug_assert!(op.well_formed() && code(op.kind).is_some());
    if matches!(
        op.kind,
        PiToPs | PiToPd | PsToPi | PdToPi | TruncPsToPi | TruncPdToPi
    ) {
        return convert(state, op, input, xmm_destination, mxcsr);
    }
    let source = match op.kind {
        Store | ToGpr | ToXmm | ExtractWord | Mask => state.raw(op.src as usize) as u64,
        Move | Binary(_) | Shift(_) | Shuffle if !op.memory => state.raw(op.src as usize) as u64,
        _ => input as u64,
    };
    let left = if matches!(op.kind, Binary(_) | Shift(_) | InsertWord) {
        state.raw(op.dst as usize) as u64
    } else {
        0
    };
    let value = match op.kind {
        Move | FromXmm | ToXmm => source,
        FromGpr | Store | ToGpr => {
            if op.wide {
                source
            } else {
                u64::from(source as u32)
            }
        }
        Binary(kind) => integer::binary(kind, left, source),
        Shift(kind) => integer::shift(
            kind,
            left,
            if op.immediate_count {
                u64::from(op.immediate)
            } else {
                source
            },
        ),
        Shuffle => integer::shuffle(source, op.immediate),
        InsertWord => {
            let shift = u32::from(op.immediate & 3) * 16;
            (left & !(0xffffu64 << shift)) | ((source & 0xffff) << shift)
        }
        ExtractWord => (source >> (u32::from(op.immediate & 3) * 16)) & 0xffff,
        Mask => integer::mask_bytes(source),
        Empty => 0,
        _ => unreachable!(),
    };
    if matches!(
        op.kind,
        Move | FromGpr | FromXmm | Binary(_) | Shift(_) | Shuffle | InsertWord
    ) {
        state.set_raw(op.dst as usize, (0xffffu128 << 64) | u128::from(value));
    }
    state.status_word &= !0x3800;
    state.tag_word = if op.kind == Empty { 0xffff } else { 0 };
    float::Outcome {
        value: u128::from(value),
        mxcsr,
        raised: 0,
        stage: None,
    }
}

fn convert(
    state: &mut x87::State,
    op: Op,
    input: u128,
    xmm_destination: u128,
    mxcsr: u32,
) -> float::Outcome {
    use Kind::*;
    let to_xmm = matches!(op.kind, PiToPs | PiToPd);
    let format = if matches!(op.kind, PiToPd | PdToPi | TruncPdToPi) {
        float::Format::F64
    } else {
        float::Format::F32
    };
    let source = if to_xmm && !op.memory {
        state.raw(op.src as usize) as u64 as u128
    } else {
        input
    };
    let left = if to_xmm {
        xmm_destination
    } else {
        u128::from(state.raw(op.dst as usize) as u64)
    };
    let kind = if to_xmm {
        float::Kind::IntToFloat
    } else if matches!(op.kind, TruncPsToPi | TruncPdToPi) {
        float::Kind::TruncToInt
    } else {
        float::Kind::FloatToInt
    };
    let mut outcome = float::eval_pair(
        float::Op {
            kind,
            format,
            scalar: false,
            integer64: false,
            predicate: 0,
        },
        left,
        source,
        mxcsr,
    );
    if outcome.stage.is_some() {
        return outcome;
    }
    if op.kind == PiToPs {
        outcome.value = (xmm_destination & !(u64::MAX as u128)) | u128::from(outcome.value as u64);
    } else if !to_xmm {
        outcome.value &= u128::from(u64::MAX);
        state.set_raw(op.dst as usize, (0xffffu128 << 64) | outcome.value);
    }
    if !(op.kind == PiToPd && op.memory) {
        state.status_word &= !0x3800;
        state.tag_word = 0;
    }
    outcome
}

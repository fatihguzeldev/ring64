mod arithmetic;
mod format;
mod lane;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Add,
    Sub,
    Mul,
    Div,
    Sqrt,
    Min,
    Max,
    Cmp,
    Comi,
    Ucomi,
    FloatConvert,
    IntToFloat,
    FloatToInt,
    TruncToInt,
    Rcp,
    Rsqrt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Format {
    F32,
    F64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Op {
    pub kind: Kind,
    pub format: Format,
    pub scalar: bool,
    pub integer64: bool,
    pub predicate: u8,
}

impl Op {
    pub fn encode(self) -> u32 {
        self.kind as u32
            | ((self.format as u32) << 4)
            | ((self.scalar as u32) << 5)
            | ((self.integer64 as u32) << 6)
            | ((self.predicate as u32) << 8)
    }

    pub fn decode(value: u32) -> Self {
        use Kind::*;
        let kind = [
            Add,
            Sub,
            Mul,
            Div,
            Sqrt,
            Min,
            Max,
            Cmp,
            Comi,
            Ucomi,
            FloatConvert,
            IntToFloat,
            FloatToInt,
            TruncToInt,
            Rcp,
            Rsqrt,
        ][(value & 15) as usize];
        Self {
            kind,
            format: if value & 16 == 0 {
                Format::F32
            } else {
                Format::F64
            },
            scalar: value & 32 != 0,
            integer64: value & 64 != 0,
            predicate: (value >> 8) as u8,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    PreComputation,
    PostComputation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub value: u128,
    pub mxcsr: u32,
    pub raised: u32,
    pub stage: Option<Stage>,
}

pub fn eval(op: Op, left: u128, right: u128, mxcsr: u32) -> Outcome {
    let masks = (mxcsr >> 7) & 0x3f;
    let source_bits = if op.kind == Kind::IntToFloat {
        if op.scalar && op.integer64 { 64 } else { 32 }
    } else {
        op.format.bits()
    };
    let output_bits = match op.kind {
        Kind::FloatConvert => op.format.opposite().bits(),
        Kind::FloatToInt | Kind::TruncToInt => {
            if op.scalar && op.integer64 {
                64
            } else {
                32
            }
        }
        _ => op.format.bits(),
    };
    let count = if op.scalar || matches!(op.kind, Kind::Comi | Kind::Ucomi) {
        1
    } else if op.kind == Kind::FloatConvert {
        2
    } else {
        128 / op.format.bits()
    };
    let mut lanes = [lane::Lane::default(); 4];
    let mut raised = 0;
    for index in 0..count {
        let a = (left >> (index * op.format.bits())) as u64 & op.format.mask();
        let b = (right >> (index * source_bits)) as u64
            & if source_bits == 32 {
                u32::MAX as u64
            } else {
                u64::MAX
            };
        lanes[index as usize] = lane::prepare(op, a, b, mxcsr);
        raised |= lanes[index as usize].pre;
    }
    if raised & !masks != 0 {
        return Outcome {
            value: left,
            mxcsr: mxcsr | raised,
            raised,
            stage: Some(Stage::PreComputation),
        };
    }
    for index in 0..count {
        lanes[index as usize] = lane::calculate(op, lanes[index as usize], mxcsr);
        raised |= lanes[index as usize].post;
    }
    if raised & !masks != 0 {
        return Outcome {
            value: left,
            mxcsr: mxcsr | raised,
            raised,
            stage: Some(Stage::PostComputation),
        };
    }
    let gpr = matches!(
        op.kind,
        Kind::FloatToInt | Kind::TruncToInt | Kind::Comi | Kind::Ucomi
    );
    let mut value = if op.scalar && !gpr {
        left & !((1u128 << output_bits) - 1)
    } else {
        0
    };
    for index in 0..count {
        value |= (lanes[index as usize].value as u128) << (index * output_bits);
    }
    Outcome {
        value,
        mxcsr: mxcsr | raised,
        raised,
        stage: None,
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod packets;

#[cfg(test)]
mod native_reference;

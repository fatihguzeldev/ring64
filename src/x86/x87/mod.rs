#[cfg(test)]
mod exception_review_tests;
mod execute;
mod number;
#[cfg(test)]
mod reference_tests;
#[cfg(test)]
mod special_tests;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct State {
    pub registers: [[u8; 10]; 8],
    pub control_word: u16,
    pub status_word: u16,
    pub tag_word: u16,
    pub opcode: u16,
    pub instruction_pointer: u64,
    pub data_pointer: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            registers: [[0; 10]; 8],
            control_word: 0x37f,
            status_word: 0,
            tag_word: 0xffff,
            opcode: 0,
            instruction_pointer: 0,
            data_pointer: 0,
        }
    }
}
pub fn classify_tag(raw: u128) -> u16 {
    number::tag(raw)
}

impl State {
    pub fn pending(&self) -> u16 {
        self.status_word & !self.control_word & 63
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.opcode > 0x7ff {
            return Err("invalid x87 opcode");
        }
        let pending = self.pending() != 0;
        if (self.status_word & 0x80 != 0) != pending || (self.status_word & 0x8000 != 0) != pending
        {
            Err("inconsistent x87 pending status")
        } else {
            Ok(())
        }
    }
    pub fn raw(&self, index: usize) -> u128 {
        let mut b = [0; 16];
        b[..10].copy_from_slice(&self.registers[index]);
        u128::from_le_bytes(b)
    }
    pub fn set_raw(&mut self, index: usize, value: u128) {
        self.registers[index].copy_from_slice(&value.to_le_bytes()[..10]);
    }
    pub fn top(&self) -> usize {
        usize::from((self.status_word >> 11) & 7)
    }
    pub fn physical(&self, index: u8) -> usize {
        (self.top() + usize::from(index)) & 7
    }
    pub fn tag(&self, index: usize) -> u16 {
        (self.tag_word >> (2 * index)) & 3
    }
    pub fn set_tag(&mut self, index: usize, tag: u16) {
        self.tag_word = (self.tag_word & !(3 << (2 * index))) | (tag << (2 * index));
    }
    pub fn refresh(&mut self) {
        self.status_word =
            (self.status_word & !0x8080) | if self.pending() != 0 { 0x8080 } else { 0 };
    }
    fn top_to(&mut self, top: usize) {
        self.status_word = (self.status_word & !0x3800) | ((top as u16 & 7) << 11);
    }
    fn put(&mut self, index: usize, value: u128) {
        self.set_raw(index, value);
        self.set_tag(index, number::tag(value));
    }
    fn pop(&mut self) {
        let top = self.top();
        self.set_tag(top, 3);
        self.top_to(top + 1);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Kind {
    Load,
    Store,
    Exchange,
    Free,
    DecTop,
    IncTop,
    #[default]
    Nop,
    ChangeSign,
    Abs,
    Test,
    Examine,
    Constant,
    Add,
    Mul,
    Compare,
    Sub,
    SubReverse,
    Div,
    DivReverse,
    Sqrt,
    Round,
    CompareUnordered,
    CompareFlags,
    CompareUnorderedFlags,
    ConditionalMove,
    LoadControl,
    StoreControl,
    StoreStatus,
    Clear,
    Init,
    Wait,
    Remainder,
    RemainderNearest,
    Scale,
    Extract,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Format {
    #[default]
    None,
    Register,
    F32,
    F64,
    F80,
    I16,
    I32,
    I64,
    Ax,
    Bcd,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Op {
    pub kind: Kind,
    pub format: Format,
    pub index: u8,
    pub dest_index: bool,
    pub pop: u8,
    pub condition: u8,
    pub encoding: u16,
}
impl Op {
    pub fn encode(self) -> u32 {
        self.kind as u32
            | ((self.format as u32) << 6)
            | (u32::from(self.index) << 10)
            | ((self.dest_index as u32) << 13)
            | (u32::from(self.pop) << 14)
            | (u32::from(self.condition) << 16)
            | (u32::from(self.encoding) << 19)
    }
    pub fn decode(n: u32) -> Self {
        Self::try_decode(n).expect("trusted x87 operation")
    }
    pub fn try_decode(n: u32) -> Option<Self> {
        use Kind::*;
        let kinds = [
            Load,
            Store,
            Exchange,
            Free,
            DecTop,
            IncTop,
            Nop,
            ChangeSign,
            Abs,
            Test,
            Examine,
            Constant,
            Add,
            Mul,
            Compare,
            Sub,
            SubReverse,
            Div,
            DivReverse,
            Sqrt,
            Round,
            CompareUnordered,
            CompareFlags,
            CompareUnorderedFlags,
            ConditionalMove,
            LoadControl,
            StoreControl,
            StoreStatus,
            Clear,
            Init,
            Wait,
            Remainder,
            RemainderNearest,
            Scale,
            Extract,
        ];
        let formats = [
            Format::None,
            Format::Register,
            Format::F32,
            Format::F64,
            Format::F80,
            Format::I16,
            Format::I32,
            Format::I64,
            Format::Ax,
            Format::Bcd,
        ];
        if n >> 30 != 0 || n & 63 == Kind::Constant as u32 && (n >> 10) & 7 == 7 {
            return None;
        }
        let op = Self {
            kind: *kinds.get((n & 63) as usize)?,
            format: *formats.get(((n >> 6) & 15) as usize)?,
            index: ((n >> 10) & 7) as u8,
            dest_index: n & (1 << 13) != 0,
            pop: ((n >> 14) & 3) as u8,
            condition: ((n >> 16) & 7) as u8,
            encoding: ((n >> 19) & 0x7ff) as u16,
        };
        op.well_formed().then_some(op)
    }
    fn well_formed(self) -> bool {
        use Format::*;
        use Kind::*;
        if self.condition != 0 && self.kind != ConditionalMove {
            return false;
        }
        if self.format != Register && self.kind != Constant && self.index != 0 {
            return false;
        }
        let arithmetic = matches!(self.kind, Add | Mul | Sub | SubReverse | Div | DivReverse);
        if self.dest_index && !(arithmetic && self.format == Register) {
            return false;
        }
        match self.kind {
            Load => {
                matches!(
                    self.format,
                    Register | F32 | F64 | F80 | I16 | I32 | I64 | Bcd
                ) && self.pop == 0
            }
            Store => {
                matches!(
                    self.format,
                    Register | F32 | F64 | F80 | I16 | I32 | I64 | Bcd
                ) && self.pop <= 1
                    && (!matches!(self.format, F80 | I64 | Bcd) || self.pop == 1)
            }
            Add | Mul | Sub | SubReverse | Div | DivReverse => {
                matches!(self.format, Register | F32 | F64 | I16 | I32)
                    && if self.dest_index {
                        self.pop <= 1
                    } else {
                        self.pop == 0
                    }
            }
            Compare => {
                matches!(self.format, Register | F32 | F64 | I16 | I32)
                    && (self.pop <= 1
                        || self.pop == 2 && self.format == Register && self.index == 1)
            }
            CompareUnordered => {
                self.format == Register && (self.pop <= 1 || self.pop == 2 && self.index == 1)
            }
            CompareFlags | CompareUnorderedFlags => self.format == Register && self.pop <= 1,
            ConditionalMove | Exchange | Free => self.format == Register && self.pop == 0,
            StoreStatus => matches!(self.format, None | Ax) && self.pop == 0,
            Constant => self.format == None && self.index < 7 && self.pop == 0,
            _ => self.format == None && self.pop == 0,
        }
    }
    pub fn is_waiting(self) -> bool {
        !matches!(
            self.kind,
            Kind::StoreControl | Kind::StoreStatus | Kind::Clear | Kind::Init
        )
    }
    pub fn memory_bytes(self) -> u32 {
        match self.format {
            Format::I16 => 2,
            Format::F32 | Format::I32 => 4,
            Format::F64 | Format::I64 => 8,
            Format::F80 | Format::Bcd => 10,
            Format::None
                if matches!(
                    self.kind,
                    Kind::LoadControl | Kind::StoreControl | Kind::StoreStatus
                ) =>
            {
                2
            }
            _ => 0,
        }
    }
    pub fn is_store(self) -> bool {
        matches!(
            self.kind,
            Kind::Store | Kind::StoreControl | Kind::StoreStatus
        ) && self.format != Format::Register
            && self.format != Format::Ax
    }
    pub fn writes_flags(self) -> bool {
        matches!(self.kind, Kind::CompareFlags | Kind::CompareUnorderedFlags)
    }
    pub fn writes_ax(self) -> bool {
        self.kind == Kind::StoreStatus && self.format == Format::Ax
    }
    pub fn updates_environment(self) -> bool {
        !matches!(
            self.kind,
            Kind::LoadControl
                | Kind::StoreControl
                | Kind::StoreStatus
                | Kind::Clear
                | Kind::Init
                | Kind::Wait
        )
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Effect {
    pub value: u128,
    pub flags: u64,
    pub store: bool,
    pub ax: bool,
}
pub fn eval(state: &mut State, op: Op, source: u128, flags: u64) -> Effect {
    execute::eval(state, op, source, flags)
}

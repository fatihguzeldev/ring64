use super::number::{self, Class, INDEFINITE, SIGN};
use super::*;
use std::cmp::Ordering;
fn status(state: &mut State, r: number::Result) {
    state.status_word = (state.status_word & !0x200) | if r.up { 0x200 } else { 0 };
    state.status_word |= r.pre | r.post;
    state.refresh();
}
fn stack_fault(state: &mut State, overflow: bool) -> bool {
    state.status_word = (state.status_word & !0x200) | 0x41 | if overflow { 0x200 } else { 0 };
    state.refresh();
    state.control_word & 1 == 0
}
fn push(state: &mut State, value: u128) {
    let p = (state.top() + 7) & 7;
    state.top_to(p);
    state.put(p, value)
}
fn predicate(c: u8, flags: u64) -> bool {
    let cf = flags & 1 != 0;
    let zf = flags & 64 != 0;
    let pf = flags & 4 != 0;
    match c {
        0 => cf,
        1 => zf,
        2 => cf || zf,
        3 => pf,
        4 => !cf,
        5 => !zf,
        6 => !cf && !zf,
        _ => !pf,
    }
}
fn pops(state: &mut State, count: u8) {
    for _ in 0..count {
        state.pop()
    }
}
fn examined(state: &mut State) {
    let p = state.top();
    let raw = state.raw(p);
    let code = if state.tag(p) == 3 {
        0x4100
    } else {
        match number::class(raw) {
            Class::Zero => 0x4000,
            Class::Finite => {
                if raw & 0x7fff0000000000000000 == 0 {
                    0x4400
                } else {
                    0x400
                }
            }
            Class::Infinity => 0x500,
            Class::QuietNan | Class::SignalingNan => 0x100,
            Class::Unsupported => 0,
        }
    };
    state.status_word =
        (state.status_word & !0x4700) | code | if raw & SIGN != 0 { 0x200 } else { 0 };
}
pub(super) fn eval(state: &mut State, op: Op, source: u128, flags: u64) -> Effect {
    use Kind::*;
    let mut out = Effect {
        value: 0,
        flags,
        store: false,
        ax: false,
    };
    let top = state.top();
    let other = state.physical(op.index);
    let a = state.raw(top);
    let b = if op.format == Format::Register {
        state.raw(other)
    } else {
        number::widen(source, op.format)
    };
    let cw = state.control_word;
    match op.kind {
        Init => {
            let registers = state.registers;
            *state = State {
                registers,
                ..State::default()
            };
            return out;
        }
        Clear => {
            state.status_word &= !0x80ff;
            return out;
        }
        LoadControl => {
            state.control_word = source as u16;
            state.refresh();
            return out;
        }
        StoreControl => {
            out.value = u128::from(state.control_word);
            out.store = true;
            return out;
        }
        StoreStatus => {
            out.value = u128::from(state.status_word);
            out.ax = op.format == Format::Ax;
            out.store = !out.ax;
            return out;
        }
        Wait | Nop => return out,
        Free => {
            state.set_tag(other, 3);
            return out;
        }
        DecTop | IncTop => {
            state.top_to((top + if op.kind == DecTop { 7 } else { 1 }) & 7);
            state.status_word &= !0x200;
            return out;
        }
        Examine => {
            examined(state);
            return out;
        }
        Load | Constant => {
            let source_empty =
                op.kind == Load && op.format == Format::Register && state.tag(other) == 3;
            let occupied = state.tag((top + 7) & 7) != 3;
            if source_empty || occupied {
                if stack_fault(state, !source_empty) {
                    return out;
                }
                push(state, INDEFINITE);
                return out;
            }
            let r = if op.kind == Constant {
                number::Result::raw(number::constant(op.index, cw))
            } else if op.format == Format::Register {
                number::Result::raw(b)
            } else {
                number::load(source, op.format)
            };
            status(state, r);
            if r.pre & !cw & 1 != 0 {
                return out;
            }
            push(state, r.value);
            return out;
        }
        Exchange => {
            let ea = state.tag(top) == 3;
            let eb = state.tag(other) == 3;
            if (ea || eb) && stack_fault(state, false) {
                return out;
            }
            if !ea && !eb {
                state.status_word &= !0x200
            }
            let va = if ea { INDEFINITE } else { a };
            let vb = if eb { INDEFINITE } else { b };
            state.put(top, vb);
            state.put(other, va);
            return out;
        }
        ConditionalMove => {
            if state.tag(top) == 3 || state.tag(other) == 3 {
                if !stack_fault(state, false) {
                    state.put(top, INDEFINITE)
                }
                return out;
            }
            if predicate(op.condition, flags) {
                state.put(top, b)
            }
            return out;
        }
        _ => {}
    }
    let compares = matches!(
        op.kind,
        Compare | CompareUnordered | CompareFlags | CompareUnorderedFlags | Test
    );
    let empty = state.tag(top) == 3
        || (op.format == Format::Register && op.kind != Store && state.tag(other) == 3);
    if empty {
        let trapped = stack_fault(state, false);
        if op.writes_flags() {
            out.flags &= !0x890
        }
        if trapped {
            return out;
        }
        if compares {
            if op.writes_flags() {
                out.flags |= 0x45
            } else {
                state.status_word = (state.status_word & !0x4500) | 0x4500
            }
        } else if op.kind == Store {
            let r = number::store(INDEFINITE, op.format, cw | 1);
            out.value = r.value;
            if op.format == Format::Register {
                state.put(other, INDEFINITE)
            } else {
                out.store = true
            }
        } else {
            let p = if op.dest_index { other } else { top };
            state.put(p, INDEFINITE)
        }
        pops(state, op.pop);
        return out;
    }
    if op.kind == Store {
        let r = number::store(a, op.format, cw);
        status(state, r);
        if r.suppress || r.pre & !cw & 63 != 0 {
            return out;
        }
        if op.format == Format::Register {
            state.put(other, r.value)
        } else {
            out.value = r.value;
            out.store = true
        }
        pops(state, op.pop);
        return out;
    }
    if op.kind == ChangeSign || op.kind == Abs {
        state.status_word &= !0x200;
        state.put(top, if op.kind == Abs { a & !SIGN } else { a ^ SIGN });
        return out;
    }
    if compares {
        let b = if op.kind == Test { 0 } else { b };
        let ca = number::class(a);
        let cb = number::class(b);
        let unordered = matches!(op.kind, CompareUnordered | CompareUnorderedFlags);
        let invalid = matches!(ca, Class::Unsupported | Class::SignalingNan)
            || matches!(cb, Class::Unsupported | Class::SignalingNan)
            || !unordered && (ca == Class::QuietNan || cb == Class::QuietNan);
        let order = number::compare(a, b);
        let pre = if invalid {
            1
        } else if order.is_none() {
            0
        } else if !op.writes_flags()
            && (number::denormal(a)
                || number::denormal(b)
                || number::memory_denormal(source, op.format))
        {
            2
        } else {
            0
        };
        state.status_word &= !0x200;
        state.status_word |= pre;
        state.refresh();
        if op.writes_flags() {
            out.flags &= !0x890
        }
        if pre & !cw & 63 != 0 {
            return out;
        }
        let code = match order {
            None => 0x45,
            Some(Ordering::Less) => 1,
            Some(Ordering::Equal) => 0x40,
            Some(Ordering::Greater) => 0,
        };
        if op.writes_flags() {
            out.flags = (out.flags & !0x45) | code
        } else {
            let c = if code == 0x45 {
                0x4500
            } else if code == 1 {
                0x100
            } else if code == 0x40 {
                0x4000
            } else {
                0
            };
            state.status_word = (state.status_word & !0x4500) | c
        }
        pops(state, op.pop);
        return out;
    }
    let r = if matches!(op.kind, Sqrt | Round) {
        number::unary(op.kind, a, cw)
    } else {
        let (lhs, rhs) = if op.dest_index { (b, a) } else { (a, b) };
        let extra = if number::memory_denormal(source, op.format) {
            2
        } else {
            0
        };
        number::binary(op.kind, lhs, rhs, cw, extra)
    };
    status(state, r);
    if r.suppress || r.pre & !cw & 63 != 0 {
        return out;
    }
    state.put(if op.dest_index { other } else { top }, r.value);
    pops(state, op.pop);
    out
}

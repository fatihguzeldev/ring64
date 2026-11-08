use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::context::Mode;
use crate::x86::instruction::{Operation, Width};
use crate::x86::numeric_images::{Format, ImageOp, Kind};

pub(super) fn legacy<F>(
    opcode: u8,
    operands: &ModRm,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let kind = match (opcode, operands.selector) {
        (0xd9, 4) => Kind::LoadEnvironment,
        (0xd9, 6) => Kind::StoreEnvironment,
        (0xdd, 4) => Kind::Restore,
        (0xdd, 6) => Kind::Save,
        _ => unreachable!(),
    };
    let real = matches!(prefixes.mode, Mode::Real | Mode::Virtual8086);
    let short = prefixes.width() == Width::W16;
    let format = match (real, short) {
        (false, true) => Format::Protected16,
        (false, false) => Format::Protected32,
        (true, true) => Format::Real16,
        (true, false) => Format::Real32,
    };
    Ok(Operation::NumericImage {
        op: ImageOp { kind, format },
        address: operands.address(cursor, prefixes)?,
    })
}

pub(super) fn fx<F>(
    operands: &ModRm,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if operands.mode == 3 {
        return Err(DecodeError::Invalid);
    }
    let format = if !prefixes.long64 {
        Format::FxLegacy
    } else if prefixes.rex.width() == Width::W64 {
        Format::Fx64Wide
    } else {
        Format::Fx64
    };
    Ok(Operation::NumericImage {
        op: ImageOp {
            kind: if operands.selector == 0 {
                Kind::SaveFx
            } else {
                Kind::RestoreFx
            },
            format,
        },
        address: operands.address(cursor, prefixes)?,
    })
}

use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::context::Segment;
use crate::x86::instruction::{
    Address, AddressBase, DataOperand, Operation, RegisterView, VectorInstruction, VectorOperand,
    Width,
};
use crate::x86::mmx::{Kind, Op};

pub(super) fn refine<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if !matches!(opcode, 0x18 | 0x2b | 0xae | 0xc3 | 0xe7 | 0xf7) {
        return None;
    }
    let mandatory = prefixes
        .repeat
        .or(prefixes.operand_override.then_some(0x66));
    if opcode != 0x18
        && !matches!(
            (opcode, mandatory),
            (0x2b | 0xe7 | 0xf7, None | Some(0x66)) | (0xae | 0xc3, None)
        )
    {
        return None;
    }
    if opcode == 0xae {
        return Some(ae(prefixes, cursor));
    }
    Some((|| {
        let operands = ModRm::read(cursor, prefixes.rex)?;
        if opcode == 0x18 {
            if operands.mode == 3 || operands.selector > 3 {
                return Err(DecodeError::Unsupported);
            }
            operands.address(cursor, prefixes)?;
            return Ok(Operation::Nop);
        }
        if opcode == 0xf7 {
            if operands.mode != 3 {
                return Err(DecodeError::Invalid);
            }
            let mmx = mandatory.is_none();
            return Ok(Operation::MaskedStore {
                data: if mmx {
                    operands.selector
                } else {
                    operands.register
                },
                mask: if mmx { operands.rm & 7 } else { operands.rm },
                mmx,
                address: Address {
                    base: AddressBase::Register(7),
                    index: None,
                    displacement: 0,
                    size: prefixes.address_width(),
                    segment: prefixes.segment_override.unwrap_or(Segment::Ds),
                },
            });
        }
        if operands.mode == 3 {
            return Err(DecodeError::Invalid);
        }
        let address = operands.address(cursor, prefixes)?;
        if opcode == 0xc3 {
            return Ok(Operation::Store {
                src: DataOperand::Register(RegisterView::low(operands.register)),
                address,
                width: if prefixes.long64 && prefixes.rex.width() == Width::W64 {
                    Width::W64
                } else {
                    Width::W32
                },
            });
        }
        if opcode == 0xe7 && mandatory.is_none() {
            return Ok(Operation::Mmx {
                op: Op {
                    kind: Kind::Store,
                    dst: 0,
                    src: operands.selector,
                    memory: true,
                    wide: true,
                    immediate: 0,
                    immediate_count: false,
                },
                address: Some(address),
            });
        }
        Ok(Operation::Vector(VectorInstruction::Move {
            register: operands.register,
            operand: VectorOperand::Memory(address),
            bytes: 16,
            preserve_upper: false,
            aligned: true,
            store: true,
        }))
    })())
}

fn ae<F>(prefixes: Prefixes, cursor: &mut Cursor<F>) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let operands = ModRm::read(cursor, prefixes.rex)?;
    if operands.selector < 2 {
        return super::numeric_image::fx(&operands, prefixes, cursor);
    }
    if matches!(operands.selector, 2 | 3) {
        if operands.mode == 3 {
            return Err(DecodeError::Invalid);
        }
        return Ok(Operation::Mxcsr {
            address: operands.address(cursor, prefixes)?,
            store: operands.selector == 3,
        });
    }
    if operands.mode == 3 && operands.selector >= 5 {
        return Ok(Operation::Nop);
    }
    if operands.mode != 3 && operands.selector == 7 {
        return Ok(Operation::Clflush {
            address: operands.address(cursor, prefixes)?,
        });
    }
    Err(DecodeError::Unsupported)
}

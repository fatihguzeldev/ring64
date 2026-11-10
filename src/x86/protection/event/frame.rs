use super::*;
use crate::memory::Access;

#[derive(Clone, Copy, Default)]
struct Write {
    address: u64,
    width: u32,
    value: u64,
}

pub(super) struct Frame {
    writes: [Write; 10],
    count: usize,
    cursor: u64,
    raw: u64,
    pointer_width: Width,
}

impl Frame {
    pub fn new(context: &ExecutionContext, sp: u64) -> Self {
        let pointer_width = context.stack_width();
        Self {
            writes: [Write::default(); 10],
            count: 0,
            cursor: sp & pointer_width.mask(),
            raw: sp,
            pointer_width,
        }
    }

    pub fn push(
        &mut self,
        context: &ExecutionContext,
        value: u64,
        width: Width,
    ) -> Result<(), EventFailure> {
        self.cursor =
            self.cursor.wrapping_sub(u64::from(width.bytes())) & self.pointer_width.mask();
        let address = context
            .translate(
                self.cursor,
                u32::from(width.bytes()),
                Segment::Ss,
                Access::Write,
                false,
            )
            .map_err(|failure| {
                if context.mode() == Mode::Long64
                    && matches!(
                        failure,
                        AccessFailure::Linear(crate::memory::Fault {
                            cause: crate::memory::Cause::Noncanonical,
                            ..
                        })
                    )
                {
                    fault(12, 0, ProtectionPhase::Target, None)
                } else {
                    EventFailure::Operand {
                        segment: Segment::Ss,
                        failure,
                    }
                }
            })?;
        self.writes[self.count] = Write {
            address,
            width: u32::from(width.bytes()),
            value,
        };
        self.count += 1;
        Ok(())
    }

    pub fn admit(&self, image: &Image) -> Result<(), EventFailure> {
        for slot in &self.writes[..self.count] {
            image
                .check_write(slot.address, slot.width)
                .map_err(|failure| EventFailure::Operand {
                    segment: Segment::Ss,
                    failure: AccessFailure::Linear(failure),
                })?;
        }
        Ok(())
    }

    pub fn commit(&self, image: &mut Image) {
        for slot in &self.writes[..self.count] {
            image
                .write(slot.address, slot.width, slot.value)
                .expect("admitted private event frame write");
        }
    }

    pub fn sp(&self) -> u64 {
        (self.raw & !self.pointer_width.mask()) | self.cursor
    }
}

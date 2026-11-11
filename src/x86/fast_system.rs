use super::context::{
    ExecutionContext, LoadedSegment, Mode, Segment, SegmentAttributes, SegmentType,
};
pub use super::paging::ControlFailure;
use super::{flags, paging, state};
use crate::memory::canonical48;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub star: u64,
    pub lstar: u64,
    pub fmask: u64,
    pub sysenter_cs: u64,
    pub sysenter_eip: u64,
    pub sysenter_esp: u64,
    pub kernel_gs_base: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instruction {
    Syscall,
    Sysret { wide: bool },
    Sysenter,
    Sysexit { wide: bool },
    Swapgs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Undefined,
    Privilege,
    Target,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    pub bank: State,
    pub scalar: state::State,
    pub context: ExecutionContext,
}

impl State {
    pub fn validate(self) -> Result<(), &'static str> {
        if self.star as u32 != 0
            || self.fmask > u32::MAX.into()
            || self.sysenter_cs > u32::MAX.into()
        {
            return Err("fast-system controls do not match the normalized IA32e profile");
        }
        if [
            self.lstar,
            self.sysenter_eip,
            self.sysenter_esp,
            self.kernel_gs_base,
        ]
        .into_iter()
        .any(|pointer| !canonical48(pointer))
        {
            return Err("fast-system pointers must be canonical48");
        }
        Ok(())
    }

    pub fn read_msr(self, index: u32, context: &ExecutionContext) -> Result<u64, ControlFailure> {
        admit_msr(context)?;
        Ok(match index {
            0xc0000081 => self.star,
            0xc0000082 => self.lstar,
            0xc0000084 => self.fmask,
            0x174 => self.sysenter_cs,
            0x175 => self.sysenter_esp,
            0x176 => self.sysenter_eip,
            0xc0000100 => context.segment(Segment::Fs).base,
            0xc0000101 => context.segment(Segment::Gs).base,
            0xc0000102 => self.kernel_gs_base,
            _ => return Err(ControlFailure::Unsupported),
        })
    }

    pub fn prepare_msr_write(
        self,
        index: u32,
        value: u64,
        context: &ExecutionContext,
    ) -> Result<(Self, ExecutionContext), ControlFailure> {
        admit_msr(context)?;
        let mut bank = self;
        let mut context = context.clone();
        match index {
            0xc0000081 => {
                if value as u32 != 0 {
                    return Err(ControlFailure::GeneralProtection);
                }
                bank.star = value;
            }
            0xc0000084 => {
                if value > u32::MAX.into() {
                    return Err(ControlFailure::GeneralProtection);
                }
                bank.fmask = value;
            }
            0x174 => bank.sysenter_cs = u64::from(value as u32),
            0xc0000082 | 0x175 | 0x176 | 0xc0000100..=0xc0000102 => {
                if !canonical48(value) {
                    return Err(ControlFailure::GeneralProtection);
                }
                match index {
                    0xc0000082 => bank.lstar = value,
                    0x175 => bank.sysenter_esp = value,
                    0x176 => bank.sysenter_eip = value,
                    0xc0000100 => set_base(&mut context, Segment::Fs, value),
                    0xc0000101 => set_base(&mut context, Segment::Gs, value),
                    _ => bank.kernel_gs_base = value,
                }
            }
            _ => return Err(ControlFailure::Unsupported),
        }
        Ok((bank, context))
    }
}

fn admit_profile(context: &ExecutionContext) -> Result<(), ControlFailure> {
    if matches!(context.mode(), Mode::Long64 | Mode::Compatibility) {
        Ok(())
    } else {
        Err(ControlFailure::Unsupported)
    }
}

fn admit_msr(context: &ExecutionContext) -> Result<(), ControlFailure> {
    admit_profile(context)?;
    if context.cpl() == 0 {
        Ok(())
    } else {
        Err(ControlFailure::GeneralProtection)
    }
}

fn set_base(context: &mut ExecutionContext, segment: Segment, base: u64) {
    let mut cache = context.segment(segment);
    cache.base = base;
    context.set_segment(
        segment,
        context.selector(segment),
        cache,
        context.attributes(segment),
    );
}

fn install(context: &mut ExecutionContext, cs: u16, ss: u16, wide: bool, cpl: u8) {
    context.set_mode_and_cpl(
        if wide {
            Mode::Long64
        } else {
            Mode::Compatibility
        },
        cpl,
    );
    for (segment, selector) in [(Segment::Cs, cs), (Segment::Ss, ss)] {
        let code = segment == Segment::Cs;
        context.set_segment(
            segment,
            selector,
            LoadedSegment {
                base: 0,
                limit: u32::MAX,
                default32: !code || !wide,
                usable: true,
                kind: if code {
                    SegmentType::ReadableCode
                } else {
                    SegmentType::ReadWrite
                },
            },
            SegmentAttributes {
                dpl: cpl,
                present: true,
                conforming: false,
                accessed: true,
                long: code && wide,
                granularity: true,
                available: false,
            },
        );
    }
}

pub fn prepare(
    instruction: Instruction,
    bank: State,
    paging: &paging::State,
    scalar: &state::State,
    context: &ExecutionContext,
    next: u64,
) -> Result<Prepared, Failure> {
    use Failure::{Privilege, Target, Undefined, Unsupported};
    use Instruction::*;
    if !matches!(context.mode(), Mode::Long64 | Mode::Compatibility) {
        return Err(Unsupported);
    }
    if !context.is_long64()
        && matches!(
            instruction,
            Syscall | Sysret { .. } | Swapgs | Sysexit { wide: true }
        )
        || matches!(instruction, Syscall | Sysret { .. }) && paging.efer & 1 == 0
    {
        return Err(Undefined);
    }
    if !matches!(instruction, Syscall | Sysenter) && context.cpl() != 0 {
        return Err(Privilege);
    }
    if matches!(instruction, Sysenter | Sysexit { .. }) && bank.sysenter_cs & 0xfffc == 0 {
        return Err(Target);
    }
    if matches!(instruction, Sysret { wide: true }) && !canonical48(scalar.registers[1])
        || matches!(instruction, Sysexit { wide: true })
            && (!canonical48(scalar.registers[1]) || !canonical48(scalar.registers[2]))
    {
        return Err(Target);
    }
    let mut prepared = Prepared {
        bank,
        scalar: scalar.clone(),
        context: context.clone(),
    };
    prepared.scalar.rip = next;
    match instruction {
        Syscall => {
            let saved = flags::architectural(scalar.flags, context) & !flags::RF;
            prepared.scalar.registers[1] = next;
            prepared.scalar.registers[11] = saved;
            prepared.scalar.flags = (saved & !bank.fmask) | 2;
            prepared.scalar.rip = bank.lstar;
            let selector = (bank.star >> 32) as u16;
            install(
                &mut prepared.context,
                selector & 0xfffc,
                selector.wrapping_add(8),
                true,
                0,
            );
        }
        Sysret { wide } => {
            prepared.scalar.rip = if wide {
                scalar.registers[1]
            } else {
                u64::from(scalar.registers[1] as u32)
            };
            prepared.scalar.flags = (scalar.registers[11] & 0x3c7fd7) | 2;
            let selector = (bank.star >> 48) as u16;
            let cs = if wide {
                selector.wrapping_add(16)
            } else {
                selector
            } | 3;
            install(
                &mut prepared.context,
                cs,
                selector.wrapping_add(8) | 3,
                wide,
                3,
            );
        }
        Sysenter => {
            prepared.scalar.rip = bank.sysenter_eip;
            prepared.scalar.registers[4] = bank.sysenter_esp;
            prepared.scalar.flags &= !(flags::IF | flags::VM);
            let cs = bank.sysenter_cs as u16 & 0xfffc;
            install(&mut prepared.context, cs, cs.wrapping_add(8), true, 0);
        }
        Sysexit { wide } => {
            prepared.scalar.rip = if wide {
                scalar.registers[2]
            } else {
                u64::from(scalar.registers[2] as u32)
            };
            prepared.scalar.registers[4] = if wide {
                scalar.registers[1]
            } else {
                u64::from(scalar.registers[1] as u32)
            };
            let cs = (bank.sysenter_cs as u16).wrapping_add(if wide { 32 } else { 16 }) | 3;
            install(&mut prepared.context, cs, cs.wrapping_add(8), wide, 3);
        }
        Swapgs => {
            prepared.bank.kernel_gs_base = context.segment(Segment::Gs).base;
            set_base(&mut prepared.context, Segment::Gs, bank.kernel_gs_base);
        }
    }
    Ok(prepared)
}

#[cfg(test)]
mod tests;

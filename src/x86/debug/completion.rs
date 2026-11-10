use super::Source;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deferred {
    pub slots: u8,
    pub origin: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Completion {
    pub pc: u64,
    pub resume: u64,
    pub completed: bool,
    pub flags: u64,
    pub single_step: bool,
    pub incoming_ss: bool,
    pub ss_producer: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub instruction_pc: u64,
    pub resume_pc: u64,
    pub completed: bool,
    pub source: Option<Source>,
    pub resume_flags: u64,
}
impl Selection {
    // FLAGS have already been projected into the current architectural context.
    pub fn new(pc: u64, resume: u64, completed: bool, flags: u64, source: Option<Source>) -> Self {
        let force_rf = matches!(source, Some(Source::GeneralDetect))
            || !completed && !matches!(source, Some(Source::Execute(_)));
        Self {
            instruction_pc: pc,
            resume_pc: resume,
            completed,
            source,
            resume_flags: flags | if force_rf { crate::x86::flags::RF } else { 0 },
        }
    }
}

// Consume only committed operand hits. SS history is independent of today's DR7
// enables; an eligible unfinished TF boundary consumes it just like completion.
pub fn complete(
    candidate: u8,
    deferred: &mut Option<Deferred>,
    at: Completion,
) -> Option<Selection> {
    if at.ss_producer && !at.incoming_ss || !at.completed && at.incoming_ss && !at.single_step {
        if candidate != 0 {
            *deferred = Some(Deferred {
                slots: candidate | deferred.map_or(0, |d| d.slots),
                origin: deferred.map_or(at.pc, |d| d.origin),
            });
        }
        return None;
    }
    let old = deferred.take();
    let slots = candidate | old.map_or(0, |d| d.slots);
    if slots == 0 && !at.single_step {
        return None;
    }
    let source = (slots != 0).then_some(Source::Data {
        slots,
        single_step: at.single_step,
        completed: at.completed,
        origin: old.map(|d| d.origin),
    });
    Some(Selection::new(
        at.pc,
        at.resume,
        at.completed,
        at.flags,
        source,
    ))
}

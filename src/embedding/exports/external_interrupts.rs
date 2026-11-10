use super::*;
use crate::embedding::layout::{DISPATCH, HALTED, PENDING_INTERRUPT, SHUTDOWN};
use crate::x86::exception::{EventState, InterruptSource};

#[unsafe(no_mangle)]
pub extern "C" fn core_request_interrupt(vector: u32) -> i32 {
    if vector > u8::MAX.into() {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let state = unsafe { &mut *bridge.core.as_mut().unwrap().state.get() };
        if state.interrupts.irq != 0 {
            return 1;
        }
        state.interrupts.irq = vector + 1;
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_request_nmi() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        unsafe {
            (*bridge.core.as_mut().unwrap().state.get())
                .interrupts
                .nmi_pending = 1
        };
        0
    })
}

fn shutdown_can_wake(core: &Core) -> bool {
    let state = unsafe { &*core.state.get() };
    state.event.kind == 2
        && state.delivery_enabled != 0
        && state.interrupts.decode().is_ok_and(|interrupts| {
            interrupts.eligible(state.flags, state.interruptibility) == Some(InterruptSource::Nmi)
        })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_shutdown_can_wake() -> i32 {
    BRIDGE.with_borrow(|bridge| i32::from(shutdown_can_wake(bridge.core.as_ref().unwrap())))
}

fn step(core: &mut Core, pc: u64, flags: u64, shadow: u32, shutdown: bool) -> i32 {
    if flags & !crate::x86::flags::IMPORTED_MASK != 0
        || flags & 2 == 0
        || !crate::x86::flags::valid_interruptibility(flags, shadow)
    {
        return -1;
    }
    let state = unsafe { &mut *core.state.get() };
    match state.event_state() {
        Ok(EventState::PendingInterrupt(_)) => return PENDING_INTERRUPT,
        Ok(EventState::Ready | EventState::Halted) => {}
        Ok(EventState::Shutdown) if shutdown => {}
        Ok(EventState::Pending(_) | EventState::Shutdown) => return DISPATCH,
        Err(_) => return -1,
    }
    let Ok(mut interrupts) = state.interrupts.decode() else {
        return -1;
    };
    if interrupts.eligible(flags, shadow).is_none() {
        return DISPATCH;
    }
    if state.delivery_enabled != 0 {
        let event = interrupts.accept(pc, flags, &core.context, shadow).unwrap();
        state.interrupts = RawInterruptState::encode(interrupts);
        state.set_event(EventState::PendingInterrupt(event));
    }
    PENDING_INTERRUPT
}

#[unsafe(no_mangle)]
pub extern "C" fn core_external_step(pc: u64, flags: u64, shadow: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| step(bridge.core.as_mut().unwrap(), pc, flags, shadow, false))
}

#[unsafe(no_mangle)]
pub extern "C" fn core_external_boundary() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let state = unsafe { &*core.state.get() };
        if state.event.kind == 2 && !shutdown_can_wake(core) {
            return SHUTDOWN;
        }
        let (pc, flags, shadow) = (state.rip, state.flags, state.interruptibility);
        let result = step(core, pc, flags, shadow, true);
        if result != DISPATCH {
            return result;
        }
        match unsafe { (*core.state.get()).event.kind } {
            3 => HALTED,
            2 => SHUTDOWN,
            _ => DISPATCH,
        }
    })
}

use crate::x86::context::{ExecutionContext, Mode};
use crate::x86::instruction::Width;

pub(super) fn restore(context: &ExecutionContext, old: u64, frame: u64, width: Width) -> u64 {
    let wide = width != Width::W16;
    if context.mode() == Mode::Real {
        return if wide {
            (frame & 0x257fd5) | (old & 0x180000) | 2
        } else {
            (old & !0xffff) | (frame & 0x7fd5) | 2
        };
    }
    let mut mask = 0x4dd5;
    if wide {
        mask |= 0x250000;
    }
    if context.mode() == Mode::Virtual8086 || u64::from(context.cpl()) <= (old >> 12) & 3 {
        mask |= 0x200;
    }
    if context.mode() != Mode::Virtual8086 && context.cpl() == 0 {
        mask |= 0x3000;
        if wide {
            mask |= 0x180000;
        }
    }
    (old & !mask) | (frame & mask) | 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::x86::protection::tests::context;

    #[test]
    fn iret_masks_use_old_privilege_and_restore_rf_vif_vip_only_for_wide() {
        for (mode, cpl, old, frame, width, expected) in [
            ("protected", 0, 2, 0x3d7fd5, Width::W32, 0x3d7fd7),
            ("long64", 0, 2, 0x3d7fd5, Width::W64, 0x3d7fd7),
            ("protected", 3, 2, 0x3d7fd5, Width::W32, 0x254dd7),
            ("protected", 3, 0x3002, 0x3d4dd5, Width::W32, 0x257dd7),
            ("protected", 0, 0x380002, 0xffff_ffff, Width::W16, 0x387fd7),
            ("real", 0, 0x180002, 0x257fd5, Width::W32, 0x3d7fd7),
            ("real", 0, 0x3d0002, 0xffff_ffff, Width::W16, 0x3d7fd7),
            ("virtual8086", 3, 0x183002, 0x257fd5, Width::W32, 0x3d7fd7),
            ("virtual8086", 3, 0x3d3002, 0, Width::W16, 0x3d3002),
        ] {
            assert_eq!(
                restore(&context(mode, cpl), old, frame, width),
                expected,
                "{mode} CPL{cpl} {width:?}"
            );
        }
    }
}

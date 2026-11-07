use super::*;

fn scalar(kind: Kind) -> Op {
    Op {
        kind,
        format: Format::F32,
        scalar: true,
        integer64: false,
        predicate: 0,
    }
}

#[test]
fn halfway_rounds_and_mask_sensitive_exact_tiny_outputs() {
    for (control, expected) in [
        (0x1f80, 0x3f800000),
        (0x3f80, 0x3f800000),
        (0x5f80, 0x3f800001),
        (0x7f80, 0x3f800000),
    ] {
        let result = eval(scalar(Kind::Add), 0x3f800000, 0x33800000, control);
        assert_eq!(result.value, expected);
        assert_eq!(result.mxcsr, control | 0x20);
        assert_eq!(result.stage, None);
    }
    for (control, value, flags, stage) in [
        (0x1f80, 0x00400000, 0, None),
        (0x9f80, 0, 0x30, None),
        (0x1780, 0x00800000, 0x10, Some(Stage::PostComputation)),
        (0x9780, 0x00800000, 0x10, Some(Stage::PostComputation)),
        (0x8f80, 0x00800000, 0x30, Some(Stage::PostComputation)),
    ] {
        let result = eval(scalar(Kind::Mul), 0x00800000, 0x3f000000, control);
        assert_eq!(result.value, value);
        assert_eq!(result.mxcsr, control | flags);
        assert_eq!(result.stage, stage);
    }
}

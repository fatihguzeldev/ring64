use super::*;

fn step(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

#[test]
fn finite_default_rounding_matches_independent_host_ieee_operations_and_square_roots() {
    let mut seed = 0x3a82fd94bc560127u64;
    for sample in 0..4096 {
        let a = step(&mut seed);
        let b = step(&mut seed);
        for format in [Format::F32, Format::F64] {
            let (a, b) = if format == Format::F32 {
                (a as u32 as u64 & 0xff7fffff, b as u32 as u64 & 0xff7fffff)
            } else {
                (a & 0xffefffffffffffff, b & 0xffefffffffffffff)
            };
            for kind in [Kind::Add, Kind::Sub, Kind::Mul, Kind::Div] {
                let expected = if format == Format::F32 {
                    let x = f32::from_bits(a as u32);
                    let y = f32::from_bits(b as u32);
                    match kind {
                        Kind::Add => x + y,
                        Kind::Sub => x - y,
                        Kind::Mul => x * y,
                        _ => x / y,
                    }
                    .to_bits() as u64
                } else {
                    let x = f64::from_bits(a);
                    let y = f64::from_bits(b);
                    match kind {
                        Kind::Add => x + y,
                        Kind::Sub => x - y,
                        Kind::Mul => x * y,
                        _ => x / y,
                    }
                    .to_bits()
                };
                let operation = Op {
                    kind,
                    format,
                    scalar: true,
                    integer64: false,
                    predicate: 0,
                };
                let r = eval(operation, a as u128, b as u128, 0x1f80);
                assert_eq!(
                    r.value as u64 & format.mask(),
                    expected,
                    "sample{sample} {format:?} {kind:?} {a:x} {b:x}"
                );
            }
            let input = a & !format.sign();
            let expected = if format == Format::F32 {
                f32::from_bits(input as u32).sqrt().to_bits() as u64
            } else {
                f64::from_bits(input).sqrt().to_bits()
            };
            let r = eval(
                Op {
                    kind: Kind::Sqrt,
                    format,
                    scalar: true,
                    integer64: false,
                    predicate: 0,
                },
                0,
                input as u128,
                0x1f80,
            );
            assert_eq!(
                r.value as u64, expected,
                "sample{sample} {format:?} SQRT {input:x}"
            );
        }
    }
}

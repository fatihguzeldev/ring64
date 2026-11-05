use super::*;

fn bytes(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn logical_case(
    code: &str,
    input: &[(usize, u64)],
    expected: &[(usize, u64)],
    flags: u64,
) -> Value {
    let code = bytes(code);
    let artifact = compiled_fixture(0x1000, &code, 0x1000);
    let mut packet = execution_case(
        &artifact.bytes,
        &artifact.entries,
        input,
        0x8d7,
        0x1000,
        1,
        (expected, flags, 0x1000 + code.len() as u64, 1, 0),
    );
    packet["flagMask"] = json!("8c7");
    packet
}

#[test]
fn logical_paths_match_independent_register_immediate_and_flag_literals() {
    let mut cases = Vec::new();
    for (code, input, expected, flags) in [
        (
            "4521c8",
            vec![(8, 0x1122334480000103), (9, 0xaabbccddffffffff)],
            vec![(8, 0x80000103)],
            0x86,
        ),
        (
            "4523c1",
            vec![(8, 0x1122334480000103), (9, 0xaabbccddffffffff)],
            vec![(8, 0x80000103)],
            0x86,
        ),
        (
            "4d09c8",
            vec![(8, 0x8000000000000000), (9, 0x101)],
            vec![(8, 0x8000000000000101)],
            0x82,
        ),
        (
            "4d0bc1",
            vec![(8, 0x8000000000000000), (9, 0x101)],
            vec![(8, 0x8000000000000101)],
            0x82,
        ),
        (
            "4d31c8",
            vec![(8, 0xffffffff000000ff), (9, 0xffffffff)],
            vec![(8, 0xffffffffffffff00)],
            0x86,
        ),
        (
            "4d33c1",
            vec![(8, 0xffffffff000000ff), (9, 0xffffffff)],
            vec![(8, 0xffffffffffffff00)],
            0x86,
        ),
        ("4531c0", vec![(8, 0x1122334400000000)], vec![(8, 0)], 0x46),
        ("4585c0", vec![(8, 0x1122334400000000)], vec![], 0x46),
        (
            "4d85c8",
            vec![(8, 0x8000000000000000), (9, 0x7fffffffffffffff)],
            vec![],
            0x46,
        ),
        ("85c0", vec![(0, 0x1122334400000100)], vec![], 0x06),
        (
            "83c800",
            vec![(0, 0x1122334480000100)],
            vec![(0, 0x80000100)],
            0x86,
        ),
        (
            "4883e080",
            vec![(0, 0x123456789abcdef0)],
            vec![(0, 0x123456789abcde80)],
            0x02,
        ),
        (
            "4881e000000080",
            vec![(0, 0x123456789abcdef0)],
            vec![(0, 0x1234567880000000)],
            0x06,
        ),
        (
            "4881c800000080",
            vec![(0, 0)],
            vec![(0, 0xffffffff80000000)],
            0x86,
        ),
        ("4ff7c000000080", vec![(8, 0x100000000)], vec![], 0x06),
        (
            "4883f0ff",
            vec![(0, 0)],
            vec![(0, 0xffffffffffffffff)],
            0x86,
        ),
        (
            "83f0ff",
            vec![(0, 0x1122334400000000)],
            vec![(0, 0xffffffff)],
            0x86,
        ),
        (
            "4883c880",
            vec![(0, 0)],
            vec![(0, 0xffffffffffffff80)],
            0x82,
        ),
        (
            "4883e0ff",
            vec![(0, 0x1122334480000100)],
            vec![(0, 0x1122334480000100)],
            0x06,
        ),
        (
            "83e0ff",
            vec![(0, 0x1122334480000100)],
            vec![(0, 0x80000100)],
            0x86,
        ),
        (
            "4881f0ffffffff",
            vec![(0, 0x8000000000000000)],
            vec![(0, 0x7fffffffffffffff)],
            0x06,
        ),
        (
            "48f7c0ffffffff",
            vec![(0, 0x8000000000000000)],
            vec![],
            0x86,
        ),
    ] {
        cases.push(logical_case(code, &input, &expected, flags));
    }
    run_cases(cases);
}

#[test]
fn logical_aliases_keep_all_register_banks_and_operand_widths_distinct() {
    let mut cases = Vec::new();
    for register in 0..16u8 {
        for width in [Width::W32, Width::W64] {
            for opcode in [0x31, 0x85] {
                let rex = 0x40
                    | if width == Width::W64 { 8 } else { 0 }
                    | if register >= 8 { 5 } else { 0 };
                let code = [rex, opcode, 0xc0 | ((register & 7) << 3) | (register & 7)];
                let artifact = compiled_fixture(0x1000, &code, 0x1000);
                let expected = if opcode == 0x31 {
                    vec![(usize::from(register), 0)]
                } else {
                    vec![]
                };
                let flags = if opcode == 0x85 && width == Width::W64 {
                    6
                } else {
                    0x46
                };
                let mut packet = execution_case(
                    &artifact.bytes,
                    &artifact.entries,
                    &[(usize::from(register), 0x1122334400000000)],
                    0x8d7,
                    0x1000,
                    1,
                    (&expected, flags, 0x1003, 1, 0),
                );
                packet["flagMask"] = json!("8c7");
                cases.push(packet);
            }
        }
    }
    run_cases(cases);
}

#[test]
fn logical_flags_remain_concrete_across_preserving_suffixes_and_arithmetic() {
    let artifact = compiled_fixture(
        0x1000,
        &bytes("4883c8004889c2488d72087505b922000000bb33000000"),
        0x1000,
    );
    assert_eq!(
        artifact.entries,
        [0x1000, 0x1004, 0x1007, 0x100b, 0x100d, 0x1012]
    );
    let mut cases = Vec::new();
    for imported_flags in [None, Some("16")] {
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, 0x100)],
            0x8d7,
            0x1000,
            1,
            (&[], 6, 0x1004, 1, 0),
        );
        packet["flagMask"] = json!("8c7");
        let suffix = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, 0x100)],
            6,
            0x1004,
            4,
            (&[(2, 0x100), (6, 0x108), (3, 0x33)], 6, 0x1017, 1, 0),
        );
        packet["preservingSuffix"] = json!({
            "pc": suffix["pc"], "budget": suffix["budget"], "expected": suffix["expected"]
        });
        if let Some(flags) = imported_flags {
            packet["preservingSuffix"]["flags"] = json!(flags);
        }
        cases.push(packet);
    }
    let arithmetic = compiled_fixture(0x1000, &bytes("4883c8004883f801"), 0x1000);
    cases.push(execution_case(
        &arithmetic.bytes,
        &arithmetic.entries,
        &[(0, 0x100)],
        0x8d7,
        0x1000,
        2,
        (&[], 0x16, 0x1008, 1, 0),
    ));
    run_cases(cases);
}

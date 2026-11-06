use super::*;

fn data_case(
    code: &[u8],
    input: &[(usize, u64)],
    expected: &[(usize, u64)],
    flags: u64,
    result_flags: u64,
) -> Value {
    let artifact = compiled_fixture(0x1000, code, 0x1000);
    execution_case(
        &artifact.bytes,
        &artifact.entries,
        input,
        flags,
        0x1000,
        1,
        (expected, result_flags, 0x1000 + code.len() as u64, 1, 0),
    )
}

#[test]
fn partial_register_writes_preserve_the_other_bits_and_original_sources() {
    let mut cases = Vec::new();
    for (code, input, expected) in [
        (
            vec![0xb4, 0x80],
            vec![(0, 0x1122334455667788)],
            vec![(0, 0x1122334455668088)],
        ),
        (
            vec![0x40, 0xb4, 0x80],
            vec![(0, 0x1122334455667788), (4, 0xaabbccddeeff0011)],
            vec![(4, 0xaabbccddeeff0080)],
        ),
        (
            vec![0x88, 0xe0],
            vec![(0, 0x1122334455667788)],
            vec![(0, 0x1122334455667777)],
        ),
        (
            vec![0x66, 0xb8, 0x00, 0x80],
            vec![(0, 0x1122334455667788)],
            vec![(0, 0x1122334455668000)],
        ),
        (
            vec![0x66, 0x8d, 0x40, 0x01],
            vec![(0, 0x112233445566ffff)],
            vec![(0, 0x1122334455660000)],
        ),
    ] {
        cases.push(data_case(&code, &input, &expected, 0x8d7, 0x8d7));
    }
    run_cases(cases);
}

#[test]
fn narrow_arithmetic_uses_its_own_sign_carry_and_auxiliary_bits() {
    let mut cases = Vec::new();
    for (code, before, after, flags) in [
        (
            vec![0x66, 0x05, 0x01, 0x00],
            0x112233445566ffff,
            0x1122334455660000,
            0x57,
        ),
        (
            vec![0x66, 0x83, 0xc0, 0x01],
            0x1122334455667fff,
            0x1122334455668000,
            0x896,
        ),
        (
            vec![0x00, 0xe0],
            0x112233445566ff01,
            0x112233445566ff00,
            0x57,
        ),
        (
            vec![0x80, 0xec, 0x01],
            0x1122334455660088,
            0x112233445566ff88,
            0x97,
        ),
    ] {
        cases.push(data_case(
            &code,
            &[(0, before)],
            &[(0, after)],
            0x8d7,
            flags,
        ));
    }
    run_cases(cases);
}

#[test]
fn extensions_and_sign_high_write_only_the_selected_view() {
    let mut cases = Vec::new();
    for (code, input, expected) in [
        (
            vec![0x0f, 0xbe, 0xc4],
            vec![(0, 0x11223344556680ff)],
            vec![(0, 0xffffff80)],
        ),
        (
            vec![0x66, 0x0f, 0xbe, 0xc4],
            vec![(0, 0x11223344556680ff)],
            vec![(0, 0x112233445566ff80)],
        ),
        (
            vec![0x48, 0x63, 0xc0],
            vec![(0, 0x1122334480008001)],
            vec![(0, 0xffffffff80008001)],
        ),
        (
            vec![0x66, 0x98],
            vec![(0, 0x1122334455667780)],
            vec![(0, 0x112233445566ff80)],
        ),
        (
            vec![0x66, 0x99],
            vec![(0, 0x8000000080008000)],
            vec![(2, 0x112233440000ffff)],
        ),
        (
            vec![0x99],
            vec![(0, 0x8000000080008000)],
            vec![(2, 0xffffffff)],
        ),
    ] {
        cases.push(data_case(&code, &input, &expected, 0x8d7, 0x8d7));
    }
    run_cases(cases);
}

#[test]
fn extension_memory_accesses_use_the_source_width_before_any_destination_write() {
    let mut cases = Vec::new();
    for (code, width, fail, expected) in [
        (
            vec![0x48, 0x0f, 0xbe, 0x03],
            1,
            false,
            vec![(0, 0xffffffffffffff80)],
        ),
        (vec![0x48, 0x0f, 0xbf, 0x03], 2, true, vec![]),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, 0x1122334455667788), (3, 0x100004000)],
            0x8d7,
            0x1000,
            1,
            (
                &expected,
                0x8d7,
                if fail { 0x1000 } else { 0x1004 },
                if fail { 6 } else { 1 },
                u64::from(fail),
            ),
        );
        packet["accesses"] = json!([
            {"kind":"load", "args":["100004000",width], "result":"80"},
            {"kind":"access_failed", "args":[], "result":u32::from(fail)}
        ]);
        cases.push(packet);
    }
    run_cases(cases);
}

#[test]
fn false_cmov_reads_before_clearing_a_32_bit_destinations_upper_half() {
    let artifact = compiled_fixture(0x1000, &[0x0f, 0x44, 0x00], 0x1000);
    let mut cases = Vec::new();
    for fail in [false, true] {
        let expected = if fail { vec![] } else { vec![(0, 0x4000)] };
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, 0x100004000)],
            0x12,
            0x1000,
            1,
            (
                &expected,
                0x12,
                if fail { 0x1000 } else { 0x1003 },
                if fail { 6 } else { 1 },
                u64::from(fail),
            ),
        );
        packet["accesses"] = json!([
            {"kind":"load", "args":["100004000",4], "result":"12345678"},
            {"kind":"access_failed", "args":[], "result":u32::from(fail)}
        ]);
        cases.push(packet);
    }
    run_cases(cases);
}

#[test]
fn false_setcc_writes_one_byte_without_a_read_import() {
    let mut packet = data_case(&[0x0f, 0x94, 0x00], &[(0, 0x100004000)], &[], 0x12, 0x12);
    packet["accesses"] = json!([
        {"kind":"store", "args":["100004000",1,"0"], "result":1}
    ]);
    run_cases(vec![packet]);
}

use super::*;
use crate::x86::instruction::{Address, AddressBase, AddressIndex};

#[test]
fn generated_mov_addresses_match_literal_memory_calls() {
    use AddressBase::{NextPc, None as NoBase, Register};
    let mut cases = Vec::new();
    for (base, index, displacement, input, pc, next_pc, expected_address) in [
        (
            Register(12),
            Some((9, 4)),
            -16,
            vec![(12, 0x100004000), (9, 5)],
            0x1000,
            0x1005,
            0x100004004u64,
        ),
        (
            NoBase,
            Some((9, 1)),
            -4,
            vec![(9, 0x100004004)],
            0x1000,
            0x1008,
            0x100004000,
        ),
        (
            NoBase,
            None,
            -16,
            vec![],
            0x1000,
            0x1008,
            0xfffffffffffffff0,
        ),
        (
            NextPc,
            None,
            -7,
            vec![],
            0x100001000,
            0x100001007,
            0x100001000,
        ),
        (NextPc, None, 0, vec![], 0xfffffffffffffff9, 0, 0),
        (
            Register(3),
            Some((1, 8)),
            0,
            vec![(3, 0xfffffffffffffff8), (1, 0x2000000100000002)],
            0x1000,
            0x1004,
            0x800000008,
        ),
        (
            Register(3),
            Some((1, 2)),
            0,
            vec![(3, 0xfffffffffffffff8), (1, 0x8000000080002004)],
            0x1000,
            0x1004,
            0x100004000,
        ),
        (
            Register(0),
            Some((0, 4)),
            8,
            vec![(0, 1)],
            0x1000,
            0x1005,
            13,
        ),
    ] {
        for width in [Width::W32, Width::W64] {
            let mut packet = case(
                vec![Instruction {
                    pc,
                    next_pc,
                    operation: Operation::Load {
                        dst: RegisterView::low(0),
                        address: Address {
                            base,
                            index: index.map(|(register, scale)| AddressIndex { register, scale }),
                            displacement,
                        },
                        width,
                    },
                }],
                &input,
                0x8d7,
                pc,
                1,
                (
                    &[(
                        0,
                        if width == Width::W32 {
                            0x44332211
                        } else {
                            0x8877665544332211
                        },
                    )],
                    0x8d7,
                    next_pc,
                    1,
                    0,
                ),
            );
            packet["accesses"] = json!([
                { "kind": "load", "args": [format!("{expected_address:x}"), width.bytes()], "result": "8877665544332211" },
                { "kind": "access_failed", "args": [], "result": 0 }
            ]);
            cases.push(packet);
        }
    }
    for (source, base, index, input, width, expected_address, expected_value) in [
        (
            8,
            12,
            9,
            vec![(12, 0x100004000), (9, 5), (8, 0x11223344aabbccdd)],
            Width::W32,
            0x100004004u64,
            0xaabbccddu64,
        ),
        (
            8,
            12,
            9,
            vec![(12, 0x100004000), (9, 5), (8, 0x11223344aabbccdd)],
            Width::W64,
            0x100004004,
            0x11223344aabbccdd,
        ),
        (
            1,
            3,
            1,
            vec![(3, 0x4000), (1, 0x100000002)],
            Width::W32,
            0x400003ff8,
            2,
        ),
        (
            0,
            0,
            1,
            vec![(0, 0x100004000), (1, 6)],
            Width::W32,
            0x100004008,
            0x4000,
        ),
    ] {
        let mut packet = case(
            vec![Instruction {
                pc: 0x1000,
                next_pc: 0x1005,
                operation: Operation::Store {
                    src: DataOperand::Register(RegisterView::low(source)),
                    address: Address {
                        base: Register(base),
                        index: Some(AddressIndex {
                            register: index,
                            scale: 4,
                        }),
                        displacement: -16,
                    },
                    width,
                },
            }],
            &input,
            0x8d7,
            0x1000,
            1,
            (&[], 0x8d7, 0x1005, 1, 0),
        );
        packet["accesses"] = json!([
            { "kind": "store", "args": [format!("{expected_address:x}"), width.bytes(), format!("{expected_value:x}")], "result": 1 }
        ]);
        cases.push(packet);
    }
    run_cases(cases);
}

#[test]
fn generated_lea_uses_current_banks_without_any_data_access() {
    let mut cases = Vec::new();
    for (code, input, pc, destination, value) in [
        (
            &[0x4f, 0x8d, 0x44, 0x8c, 0xf0][..],
            vec![(12, 0x1000), (9, 5)],
            0x1000,
            8,
            0x1004,
        ),
        (
            &[0x48, 0x8d, 0x04, 0xe4][..],
            vec![(4, 0x1000), (12, 0x10)],
            0x1000,
            0,
            0x1000,
        ),
        (
            &[0x4a, 0x8d, 0x04, 0xe4][..],
            vec![(4, 0x1000), (12, 0x10)],
            0x1000,
            0,
            0x1080,
        ),
        (
            &[0x49, 0x8d, 0x04, 0x25, 0xfc, 0xff, 0xff, 0xff][..],
            vec![(13, 0x4000)],
            0x1000,
            0,
            0xfffffffffffffffc,
        ),
        (
            &[0x49, 0x8d, 0x05, 0xf9, 0xff, 0xff, 0xff][..],
            vec![],
            0x100001000,
            0,
            0x100001000,
        ),
        (
            &[0x48, 0x8d, 0x43, 1][..],
            vec![(3, 0x7fffffffffff)],
            0x1000,
            0,
            0x800000000000,
        ),
        (
            &[0x8d, 0x43, 1][..],
            vec![(3, 0x7fffffffffff)],
            0x1000,
            0,
            0,
        ),
        (
            &[0x48, 0x8d, 0x04, 0xcb][..],
            vec![(3, 0xfffffffffffffff8), (1, 0x2000000100000002)],
            0x1000,
            0,
            0x800000008,
        ),
        (
            &[0x48, 0x8d, 0x44, 0x80, 8][..],
            vec![(0, 1)],
            0x1000,
            0,
            13,
        ),
        (
            &[0x48, 0x8d, 0x03][..],
            vec![(3, 0x8000)],
            0x1000,
            0,
            0x8000,
        ),
        (
            &[0x48, 0x8d, 0x43, 8][..],
            vec![(3, 0x6ff8)],
            0x1000,
            0,
            0x7000,
        ),
        (
            &[0x48, 0x8d, 0x05, 0, 0, 0, 0][..],
            vec![],
            0xfffffffffffffff9,
            0,
            0,
        ),
        (
            &[0x47, 0x8d, 0x44, 0x8c, 0xf0][..],
            vec![(12, 0x1122334400001000), (9, 5)],
            0x1000,
            8,
            0x1004,
        ),
    ] {
        let artifact = compiled_fixture(pc, code, pc);
        for flags in [0x2, 0x3, 0x6, 0x12, 0x42, 0x82, 0x802, 0x8d7] {
            cases.push(execution_case(
                &artifact.bytes,
                &artifact.entries,
                &input,
                flags,
                pc,
                1,
                (
                    &[(destination, value)],
                    flags,
                    pc.wrapping_add(code.len() as u64),
                    1,
                    0,
                ),
            ));
        }
    }
    let artifact = compiled_fixture(
        0x1000,
        &[
            0xbb, 0, 0x40, 0, 0, 0x48, 0x8d, 0x34, 0x8b, 0x48, 0x8d, 0x15, 0, 0, 0, 0,
        ],
        0x1000,
    );
    assert_eq!(artifact.entries, [0x1000, 0x1005, 0x1009]);
    for flags in [0x2, 0x3, 0x6, 0x12, 0x42, 0x82, 0x802, 0x8d7] {
        for (input, expected) in [
            (
                vec![(3, 0x100005000), (1, 2)],
                vec![(6, 0x100005008), (2, 0x1010)],
            ),
            (
                vec![(3, 0x200006000), (1, 7)],
                vec![(6, 0x20000601c), (2, 0x1010)],
            ),
        ] {
            cases.push(execution_case(
                &artifact.bytes,
                &artifact.entries,
                &input,
                flags,
                0x1005,
                2,
                (&expected, flags, 0x1010, 1, 0),
            ));
        }
    }
    run_cases(cases);
}

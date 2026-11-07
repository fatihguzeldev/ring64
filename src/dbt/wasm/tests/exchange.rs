use super::*;
use crate::embedding::layout::{BUDGET, DATA};
use crate::x86::instruction::{Address, AddressBase, Location};

fn packet(operation: Operation, input: &[(usize, u64)], outcome: Outcome<'_>) -> Value {
    let mut p = case(
        vec![Instruction { pc: 0x1000, next_pc: 0x1003, operation }],
        input, 0xcd7, 0x1000, 1, outcome,
    );
    p["repeatBudget"] = json!(23);
    p["expected"]["repeatRemaining"] = json!("23");
    p
}

#[test]
fn register_exchange_and_nop_keep_distinct_alias_write_semantics() {
    let mut cases = vec![packet(Operation::Nop, &[], (&[], 0xcd7, 0x1003, BUDGET as u32, 0))];
    for (dst, src, width, input, expected) in [
        (RegisterView::low(0), RegisterView::high_byte(0), Width::W8, vec![(0, 0x112233445566127f)], vec![(0, 0x1122334455667f12)]),
        (RegisterView::low(0), RegisterView::low(0), Width::W32, vec![(0, 0x1122334455667788)], vec![(0, 0x55667788)]),
        (RegisterView::low(0), RegisterView::low(8), Width::W32, vec![(0, 0x1122334455667788), (8, 0xdeadbeef01020304)], vec![(0, 0x01020304), (8, 0x55667788)]),
        (RegisterView::low(0), RegisterView::low(8), Width::W16, vec![(0, 0x1122334455667788), (8, 0xdeadbeef01020304)], vec![(0, 0x1122334455660304), (8, 0xdeadbeef01027788)]),
        (RegisterView::low(15), RegisterView::low(9), Width::W64, vec![(15, 0x1122334455667788), (9, 0xdeadbeef01020304)], vec![(15, 0xdeadbeef01020304), (9, 0x1122334455667788)]),
    ] {
        cases.push(packet(Operation::Exchange {dst:Location::Register(dst),src,width}, &input, (&expected,0xcd7,0x1003,BUDGET as u32,0)));
    }
    run_cases(cases);
}

#[test]
fn xadd_snapshots_same_bank_views_and_the_final_destination_sum_wins() {
    let mut cases=vec![];
    for (dst,src,width,input,expected,flags) in [
        (RegisterView::low(0),RegisterView::high_byte(0),Width::W8,vec![(0,0x112233445566127f)],vec![(0,0x1122334455667f91)],0xc92),
        (RegisterView::high_byte(0),RegisterView::low(0),Width::W8,vec![(0,0x1122334455661234)],vec![(0,0x1122334455664612)],0x402),
        (RegisterView::low(0),RegisterView::low(0),Width::W8,vec![(0,0x1122334455661280)],vec![(0,0x1122334455661200)],0xc47),
        (RegisterView::low(0),RegisterView::low(0),Width::W32,vec![(0,0x1122334400000003)],vec![(0,6)],0x406),
        (RegisterView::low(1),RegisterView::low(2),Width::W16,vec![(1,0x112233440000ffff),(2,0x99aabbcc00000001)],vec![(1,0x1122334400000000),(2,0x99aabbcc0000ffff)],0x457),
        (RegisterView::low(8),RegisterView::low(9),Width::W64,vec![(8,u64::MAX),(9,1)],vec![(8,0),(9,u64::MAX)],0x457),
    ] {
        cases.push(packet(Operation::Xadd{dst:Location::Register(dst),src,width},&input,(&expected,flags,0x1003,BUDGET as u32,0)));
    }
    run_cases(cases);
}

#[test]
fn compare_exchange_registers_publish_only_the_selected_view_write() {
    let mut cases=vec![];
    for (dst,src,width,input,expected,flags) in [
        (RegisterView::low(1),RegisterView::low(3),Width::W32,vec![(0,0x1122334400000001),(1,0x99aabbcc00000002),(3,3)],vec![(0,2)],0x497),
        (RegisterView::low(1),RegisterView::low(3),Width::W32,vec![(0,0x1122334400000001),(1,0x99aabbcc00000001),(3,3)],vec![(1,3)],0x446),
        (RegisterView::low(0),RegisterView::low(3),Width::W32,vec![(0,0x1122334400000001),(3,3)],vec![(0,3)],0x446),
        (RegisterView::high_byte(0),RegisterView::low(3),Width::W8,vec![(0,0x1122334455661212),(3,0x34)],vec![(0,0x1122334455663412)],0x446),
        (RegisterView::high_byte(0),RegisterView::low(3),Width::W8,vec![(0,0x1122334455661210),(3,0x34)],vec![(0,0x1122334455661212)],0x493),
    ] {
        cases.push(packet(Operation::CompareExchange{dst:Location::Register(dst),src,width},&input,(&expected,flags,0x1003,BUDGET as u32,0)));
    }
    run_cases(cases);
}

fn at(register:u8)->Address { Address {base:AddressBase::Register(register),..Address::default()} }

#[test]
fn exchange_memory_captures_addresses_and_stages_registers_and_flags_until_store() {
    let mut cases=vec![];
    for family in 0..3 {
        for (read_failed,store_failed) in [(true,false),(false,true),(false,false)] {
            let success=!read_failed&&!store_failed;
            let (operation,input,loaded,stored,expected,flags)=match family {
                0=>(Operation::Exchange{dst:Location::Memory(at(6)),src:RegisterView::low(6),width:Width::W64},vec![(6,0x6000)],0x7000u64,0x6000u64,vec![(6,0x7000)],0xcd7),
                1=>(Operation::Xadd{dst:Location::Memory(at(0)),src:RegisterView::low(0),width:Width::W32},vec![(0,0x6000)],7,0x6007,vec![(0,7)],0x402),
                _=>(Operation::CompareExchange{dst:Location::Memory(at(6)),src:RegisterView::low(3),width:Width::W32},vec![(6,0x6000),(0,0x1122334400000001),(3,3)],2,2,vec![(0,2)],0x497),
            };
            let width=if family==0 {8}else{4};
            let mut p=packet(operation,&input,(if success {&expected}else{&[]},if success {flags}else{0xcd7},if success {0x1003}else{0x1000},if success {BUDGET}else{DATA} as u32,u64::from(!success)));
            let mut accesses=vec![json!({"kind":"load_for_write","args":["6000",width],"result":format!("{loaded:x}")}),json!({"kind":"access_failed","args":[],"result":u32::from(read_failed)})];
            if !read_failed {accesses.push(json!({"kind":"store","args":["6000",width,format!("{stored:x}")],"result":u32::from(!store_failed)}));}
            p["accesses"]=json!(accesses);
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn compare_exchange8b_captures_pairs_preserves_hit_banks_and_stages_miss_outputs() {
    let mut cases=vec![];
    for hit in [false,true] {
        for (read_failed,store_failed) in [(true,false),(false,true),(false,false)] {
            let success=!read_failed&&!store_failed;
            let loaded=0x5566778811223344u64;
            let input=[(0,if hit {0xaaaabbbb11223344}else{0xaaaabbbb00000000}),(2,if hit {0xccccdddd55667788}else{0xccccdddd00000000}),(3,0xeeeeffff89abcdef),(1,0x1111222201234567),(6,0x6000)];
            let expected=if success&&!hit {vec![(0,0x11223344),(2,0x55667788)]}else{vec![]};
            let mut p=packet(Operation::CompareExchange8b{address:at(6)},&input,(&expected,if success&&!hit {0xc97}else{0xcd7},if success {0x1003}else{0x1000},if success {BUDGET}else{DATA} as u32,u64::from(!success)));
            let mut accesses=vec![json!({"kind":"load_for_write","args":["6000",8],"result":format!("{loaded:x}")}),json!({"kind":"access_failed","args":[],"result":u32::from(read_failed)})];
            if !read_failed {accesses.push(json!({"kind":"store","args":["6000",8,if hit {"123456789abcdef"}else{"5566778811223344"}],"result":u32::from(!store_failed)}));}
            p["accesses"]=json!(accesses);
            cases.push(p);
        }
    }
    run_cases(cases);
}

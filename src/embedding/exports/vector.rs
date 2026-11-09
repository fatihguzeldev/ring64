use super::*;

pub(super) struct AlignmentFault {
    pub(super) segment: Segment,
    pub(super) offset: u64,
    pub(super) address: u64,
    pub(super) width: u32,
    pub(super) access: Access,
    pub(super) alignment: u32,
}

impl AlignmentFault {
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "segment":self.segment.name(),
            "offset":format!("0x{:x}",self.offset),
            "address":format!("0x{:x}",self.address),
            "width":self.width,
            "access":match self.access {Access::Read=>"read",Access::Write=>"write",Access::Execute=>unreachable!()},
            "alignment":self.alignment,
        })
    }
}

impl Core {
    pub(super) fn vector_address(
        &mut self,
        offset: u64,
        width: u32,
        segment: u32,
        alignment: u32,
        access: Access,
    ) -> Option<u64> {
        assert!(matches!(width, 2 | 4 | 8 | 16));
        assert!(alignment == 1 || alignment == 16 && width == 16);
        self.alignment_fault = None;
        let segment = Segment::from_id(segment);
        let address = self.segment_address(offset, width, segment, access, false)?;
        if address & u64::from(alignment - 1) != 0 {
            self.alignment_fault = Some(AlignmentFault {
                segment,
                offset,
                address,
                width,
                access,
                alignment,
            });
            None
        } else {
            Some(address)
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_import_xmm() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        if bridge.input.len() != 256 {
            return bridge.error("XMM state input length differs");
        }
        let bank = std::array::from_fn(|index| {
            bridge.input[index * 16..index * 16 + 16]
                .try_into()
                .unwrap()
        });
        let core = bridge.core.as_mut().unwrap();
        unsafe {
            let state = &mut *core.state.get();
            state.xmm = bank;
            state.target = 0;
            state.fault_segment = Segment::Cs as u32;
        }
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.divide_failed = false;
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_vector_load(offset: u64, width: u32, segment: u32, alignment: u32) -> u32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let Some(address) = core.vector_address(offset, width, segment, alignment, Access::Read)
        else {
            return 0;
        };
        match core.image.read_vector(address, width) {
            Ok(bytes) => unsafe {
                let state = &mut *core.state.get();
                state.vector_scratch = bytes;
                state.vector_scratch.as_ptr() as u32
            },
            Err(fault) => {
                core.fault = Some(fault);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_vector_store(
    offset: u64,
    width: u32,
    segment: u32,
    alignment: u32,
    value_ptr: u32,
) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let bytes = unsafe {
            let state = &*core.state.get();
            assert_eq!(
                state.vector_scratch.as_ptr() as u32,
                value_ptr,
                "invalid vector scratch pointer"
            );
            state.vector_scratch
        };
        let Some(address) = core.vector_address(offset, width, segment, alignment, Access::Write)
        else {
            return 0;
        };
        match core.image.write_bytes(address, &bytes[..width as usize]) {
            Ok(()) => {
                if core.image.active_changed() {
                    2
                } else {
                    1
                }
            }
            Err(fault) => {
                core.fault = Some(fault);
                0
            }
        }
    })
}

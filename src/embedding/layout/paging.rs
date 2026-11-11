use crate::x86::exception::EventState;
use std::mem::{offset_of, size_of};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct RawPagingSource {
    pub address: u64,
    pub has_address: u32,
    pub reserved: u32,
}

impl RawPagingSource {
    pub fn decode(self) -> Result<Option<u64>, &'static str> {
        if self.reserved != 0 || self.has_address > 1 || self.has_address == 0 && self.address != 0
        {
            return Err("invalid page fault source transport");
        }
        if self.has_address != 0 {
            if !crate::memory::canonical48(self.address) {
                return Err("noncanonical page fault source address");
            }
            Ok(Some(self.address))
        } else {
            Ok(None)
        }
    }

    pub fn encode(address: Option<u64>) -> Self {
        Self {
            address: address.unwrap_or(0),
            has_address: address.is_some().into(),
            reserved: 0,
        }
    }

    pub fn attach(self, event: &mut EventState) -> Result<(), &'static str> {
        let address = self.decode()?;
        if let EventState::Pending(pending) = event {
            if (pending.vector == 14) != address.is_some() {
                return Err("page fault address requires matching vector fourteen");
            }
            pending.page_fault_address = address;
        } else if address.is_some() {
            return Err("page fault address requires pending exception");
        }
        Ok(())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != size_of::<Self>() {
            return Err("page fault source input length differs");
        }
        let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        let raw = Self {
            address: u64::from_le_bytes(
                bytes[offset_of!(Self, address)..offset_of!(Self, address) + 8]
                    .try_into()
                    .unwrap(),
            ),
            has_address: word(offset_of!(Self, has_address)),
            reserved: word(offset_of!(Self, reserved)),
        };
        raw.decode()?;
        Ok(raw)
    }

    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({"bytes":size_of::<Self>(),"address":offset_of!(Self,address),"hasAddress":offset_of!(Self,has_address),"reserved":offset_of!(Self,reserved)})
    }
}

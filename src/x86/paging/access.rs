use std::cell::RefCell;

use super::{
    State,
    walk::{self, PhysicalPhase, Request},
};
use crate::memory::{Access, Image, PreparedPhysicalUpdate, PreparedPhysicalWrite, check_span};
use crate::x86::{access::GuestMemory, context::AccessFailure};

#[derive(Debug)]
struct Fragment {
    offset: u32,
    length: u32,
    request: Request,
    translation: walk::Translation,
    write: Option<PreparedPhysicalWrite>,
}

#[derive(Debug)]
struct Prepared {
    address: u64,
    width: u32,
    fragments: Vec<Fragment>,
    published: bool,
    fields: Vec<(u32, u32)>,
}

#[derive(Debug, Default)]
pub struct AccessState {
    pending: Vec<Prepared>,
}

impl AccessState {
    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

struct Storage<'a> {
    image: &'a mut Image,
    work: &'a mut AccessState,
}

pub struct Memory<'a> {
    storage: RefCell<Storage<'a>>,
    paging: &'a State,
    user: bool,
}

impl<'a> Memory<'a> {
    pub fn new(
        image: &'a mut Image,
        paging: &'a State,
        cpl: u8,
        work: &'a mut AccessState,
    ) -> Self {
        Self {
            storage: RefCell::new(Storage { image, work }),
            paging,
            user: cpl == 3,
        }
    }

    fn prepare(
        &self,
        address: u64,
        width: u32,
        access: Access,
        rmw: bool,
        user: bool,
    ) -> Result<Prepared, AccessFailure> {
        check_span(address, width, access).map_err(AccessFailure::Linear)?;
        let mut prepared = Prepared {
            address,
            width,
            fragments: Vec::new(),
            published: false,
            fields: vec![(0, width)],
        };
        let mut offset = 0;
        let mut storage = self.storage.borrow_mut();
        while offset < width {
            let request = Request {
                linear: address + u64::from(offset),
                access,
                user,
            };
            let translation =
                walk::walk(storage.image, self.paging, request).map_err(AccessFailure::Paging)?;
            let length = (width - offset).min(translation.remaining as u32);
            let write = if access == Access::Write {
                storage
                    .image
                    .prepare_physical_write(translation.physical, length, rmw)
                    .map(Some)
            } else {
                storage
                    .image
                    .physical_check_access(translation.physical, length, access, rmw)
                    .map(|_| None)
            }
            .map_err(|f| {
                AccessFailure::Paging(request.physical_failure(f, PhysicalPhase::FinalAccess))
            })?;
            prepared.fragments.push(Fragment {
                offset,
                length,
                request,
                translation,
                write,
            });
            offset += length;
        }
        Ok(prepared)
    }

    fn read_prepared(&self, prepared: &Prepared, output: &mut [u8]) {
        let storage = self.storage.borrow();
        for fragment in &prepared.fragments {
            let bytes = storage
                .image
                .physical_read_bytes(fragment.translation.physical, fragment.length)
                .expect("captured physical read admission");
            output[fragment.offset as usize..(fragment.offset + fragment.length) as usize]
                .copy_from_slice(&bytes);
        }
    }

    fn read_at(&self, address: u64, width: u32, user: bool) -> Result<[u8; 16], AccessFailure> {
        assert!(width <= 16);
        let prepared = self.prepare(address, width, Access::Read, false, user)?;
        let mut bytes = [0; 16];
        self.read_prepared(&prepared, &mut bytes);
        Ok(bytes)
    }

    fn capture_write(&self, address: u64, width: u32, user: bool) -> Result<(), AccessFailure> {
        self.capture_write_fields(address, width, &[(0, width)], user)
    }

    fn capture_write_fields(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        user: bool,
    ) -> Result<(), AccessFailure> {
        let mut prepared = self.prepare(address, width, Access::Write, false, user)?;
        prepared.fields = fields.to_vec();
        self.storage.borrow_mut().work.pending.push(prepared);
        Ok(())
    }

    fn dirty_admission(
        &self,
        prepared: &Prepared,
        fields: &[(u32, u32)],
    ) -> Result<Vec<PreparedPhysicalUpdate>, AccessFailure> {
        let storage = self.storage.borrow();
        let mut updates = Vec::new();
        for fragment in &prepared.fragments {
            if fragment.translation.dirty && participates(fragment, fields) {
                let update = storage
                    .image
                    .prepare_physical_update(fragment.translation.leaf)
                    .map_err(|f| {
                        AccessFailure::Paging(
                            fragment
                                .request
                                .physical_failure(f, PhysicalPhase::DirtyWrite),
                        )
                    })?;
                updates.push(update);
            }
        }
        Ok(updates)
    }

    fn dirty_publish(&self, updates: &[PreparedPhysicalUpdate]) {
        let mut storage = self.storage.borrow_mut();
        for update in updates {
            storage.image.publish_physical_update(update, walk::DIRTY);
        }
    }

    fn write_at(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        bytes: &[u8],
        user: bool,
    ) -> Result<(), AccessFailure> {
        let captured = {
            let mut storage = self.storage.borrow_mut();
            let index = storage
                .work
                .pending
                .iter()
                .position(|p| p.address == address && p.width == width);
            index.map(|i| storage.work.pending.remove(i))
        };
        let prepared = match captured {
            Some(p) => p,
            None => self.prepare(address, width, Access::Write, false, user)?,
        };
        if !prepared.published {
            let updates = self.dirty_admission(&prepared, fields)?;
            self.dirty_publish(&updates);
        }
        let mut storage = self.storage.borrow_mut();
        for fragment in &prepared.fragments {
            for &(start, length) in fields {
                let begin = start.max(fragment.offset);
                let end = (start + length).min(fragment.offset + fragment.length);
                if begin < end {
                    storage.image.publish_physical(
                        fragment
                            .write
                            .as_ref()
                            .expect("captured physical payload admission"),
                        begin - fragment.offset,
                        &bytes[begin as usize..end as usize],
                    );
                }
            }
        }
        Ok(())
    }
}

fn participates(fragment: &Fragment, fields: &[(u32, u32)]) -> bool {
    fields.iter().any(|&(start, length)| {
        start < fragment.offset + fragment.length && fragment.offset < start + length
    })
}

impl GuestMemory for Memory<'_> {
    fn fetch(&self, address: u64) -> Result<u8, AccessFailure> {
        let prepared = self.prepare(address, 1, Access::Execute, false, self.user)?;
        let storage = self.storage.borrow();
        Ok(storage
            .image
            .physical_fetch(prepared.fragments[0].translation.physical)
            .expect("admitted physical fetch"))
    }
    fn read(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        let bytes = self.read_at(address, width, self.user)?;
        Ok(u64::from_le_bytes(bytes[..8].try_into().unwrap()))
    }
    fn read_for_write(&self, address: u64, width: u32) -> Result<u64, AccessFailure> {
        let prepared = self.prepare(address, width, Access::Write, true, self.user)?;
        let mut bytes = [0; 8];
        self.read_prepared(&prepared, &mut bytes);
        self.storage.borrow_mut().work.pending.push(prepared);
        Ok(u64::from_le_bytes(bytes))
    }
    fn read_vector(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure> {
        self.read_at(address, width, self.user)
    }
    fn read_fields(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        output: &mut [u8],
    ) -> Result<(), AccessFailure> {
        let prepared = self.prepare(address, width, Access::Read, false, self.user)?;
        let storage = self.storage.borrow();
        for fragment in &prepared.fragments {
            for &(start, length) in fields {
                let begin = start.max(fragment.offset);
                let end = (start + length).min(fragment.offset + fragment.length);
                if begin < end {
                    let bytes = storage
                        .image
                        .physical_read_bytes(
                            fragment.translation.physical + u64::from(begin - fragment.offset),
                            end - begin,
                        )
                        .expect("admitted physical field read");
                    output[begin as usize..end as usize].copy_from_slice(&bytes);
                }
            }
        }
        Ok(())
    }
    fn write(&mut self, address: u64, width: u32, value: u64) -> Result<(), AccessFailure> {
        self.write_at(
            address,
            width,
            &[(0, width)],
            &value.to_le_bytes(),
            self.user,
        )
    }
    fn write_bytes(&mut self, address: u64, bytes: &[u8]) -> Result<(), AccessFailure> {
        self.write_at(
            address,
            bytes.len() as u32,
            &[(0, bytes.len() as u32)],
            bytes,
            self.user,
        )
    }
    fn write_fields(
        &mut self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        bytes: &[u8],
    ) -> Result<(), AccessFailure> {
        self.write_at(address, width, fields, bytes, self.user)
    }
    fn check_read(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        self.prepare(address, width, Access::Read, false, self.user)
            .map(|_| ())
    }
    fn check_write(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        self.capture_write(address, width, self.user)
    }
    fn read_system(&self, address: u64, width: u32) -> Result<[u8; 16], AccessFailure> {
        self.read_at(address, width, false)
    }
    fn check_system_write(&self, address: u64, width: u32) -> Result<(), AccessFailure> {
        self.capture_write(address, width, false)
    }
    fn check_system_write_fields(
        &self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
    ) -> Result<(), AccessFailure> {
        self.capture_write_fields(address, width, fields, false)
    }
    fn write_system(&mut self, address: u64, width: u32, value: u64) -> Result<(), AccessFailure> {
        self.write_at(address, width, &[(0, width)], &value.to_le_bytes(), false)
    }
    fn write_system_fields(
        &mut self,
        address: u64,
        width: u32,
        fields: &[(u32, u32)],
        bytes: &[u8],
    ) -> Result<(), AccessFailure> {
        self.write_at(address, width, fields, bytes, false)
    }
    fn check_frame_write(&self, address: u64, width: u32, cpl: u8) -> Result<(), AccessFailure> {
        self.capture_write(address, width, cpl == 3)
    }
    fn prepare_publication(&mut self) -> Result<(), AccessFailure> {
        let pending = std::mem::take(&mut self.storage.borrow_mut().work.pending);
        let mut updates = Vec::new();
        for prepared in &pending {
            updates.extend(self.dirty_admission(prepared, &prepared.fields)?);
        }
        self.dirty_publish(&updates);
        self.storage.borrow_mut().work.pending = pending
            .into_iter()
            .map(|mut p| {
                p.published = true;
                p
            })
            .collect();
        Ok(())
    }
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;

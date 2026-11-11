use std::collections::HashMap;

use crate::x86::context::ExecutionContext;

#[derive(Debug)]
struct Assumptions {
    context: ExecutionContext,
    observed: bool,
    epoch: u64,
    published: bool,
}

/// Compiled assumptions share the memory source owner's identity and lifetime.
#[derive(Debug, Default)]
pub(crate) struct Owners {
    records: HashMap<u64, Assumptions>,
}

impl Owners {
    pub fn register(
        &mut self,
        owner: u64,
        context: &ExecutionContext,
        observed: bool,
        epoch: u64,
    ) -> bool {
        if self.records.try_reserve(1).is_err() {
            return false;
        }
        self.records.insert(
            owner,
            Assumptions {
                context: context.clone(),
                observed,
                epoch,
                published: false,
            },
        );
        true
    }

    pub fn contains(&self, owner: u64) -> bool {
        self.records.contains_key(&owner)
    }

    pub fn eligible(&self, owner: u64, context: &ExecutionContext, observed: bool) -> bool {
        self.records.get(&owner).is_some_and(|record| {
            record.published && record.context == *context && record.observed == observed
        })
    }

    pub fn publish(
        &mut self,
        owner: u64,
        context: &ExecutionContext,
        observed: bool,
        epoch: u64,
    ) -> bool {
        let Some(record) = self.records.get_mut(&owner) else {
            return false;
        };
        if record.context != *context
            || record.observed != observed
            || !record.published && record.epoch != epoch
        {
            return false;
        }
        record.published = true;
        true
    }

    pub fn cancel_pending(&mut self, mut release: impl FnMut(u64)) {
        self.records.retain(|&owner, record| {
            if record.published {
                true
            } else {
                release(owner);
                false
            }
        });
    }

    pub fn release(&mut self, owner: u64) {
        self.records.remove(&owner);
    }

    pub fn clear(&mut self) {
        self.records.clear();
    }
}

#[cfg(test)]
mod tests;

use super::*;

impl Core {
    pub(super) fn owner_alive(&self, owner: u64) -> bool {
        self.translation_owners.contains(owner) && self.image.owner_valid(owner)
    }

    pub(super) fn publish_owner(&mut self, owner: u64) -> bool {
        if !self.image.owner_valid(owner) {
            return false;
        }
        let observed = self.boundary_observed();
        self.translation_owners
            .publish(owner, &self.context, observed, self.context_version)
    }

    pub(super) fn activate_owner(&mut self, owner: u64) -> bool {
        let observed = self.boundary_observed();
        self.translation_owners
            .admit(owner, &self.context, observed, || {
                self.image.activate(owner)
            })
    }

    pub(super) fn context_changed(&mut self) {
        // Pending owners are cancelled even when the externally reported epoch saturates.
        self.translation_owners
            .cancel_pending(|owner| self.image.release(owner));
        self.context_version = self.context_version.saturating_add(1);
    }

    pub(super) fn retire_translations(&mut self) {
        self.image.retire_sources();
        self.translation_owners.clear();
        self.context_version = self.context_version.saturating_add(1);
    }
}

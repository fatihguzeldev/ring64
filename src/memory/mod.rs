mod access;
mod address;
mod image;
mod validity;

pub(crate) use address::check_span;

pub use address::{Access, Cause, Fault, canonical48};
pub use image::{Image, MappingInput, MemoryError, MemoryLimits, Permissions};

#[cfg(test)]
mod mapped_tests;

#[cfg(test)]
mod vector_tests;

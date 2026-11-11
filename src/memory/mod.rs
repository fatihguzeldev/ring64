mod access;
mod address;
mod image;
mod validity;

pub(crate) use address::check_span;

pub use address::{Access, Cause, Fault, PHYSICAL_ADDRESS_END, canonical48};
pub use image::{Image, MappingInput, MemoryError, MemoryLimits, Permissions};

#[cfg(test)]
mod field_tests;

#[cfg(test)]
mod mapped_tests;

#[cfg(test)]
mod physical_tests;

#[cfg(test)]
mod dependency_tests;

#[cfg(test)]
mod vector_tests;

#[cfg(test)]
mod vector_read_tests;

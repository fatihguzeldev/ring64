mod discovery;
mod ownership;
pub(crate) use ownership::Owners;
mod unit;
mod wasm;

use crate::memory::Image;
use crate::x86::context::ExecutionContext;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_instructions: u32,
    pub max_source_bytes: u32,
    pub max_artifact_bytes: u32,
}

#[derive(Debug)]
pub struct Artifact {
    pub bytes: Vec<u8>,
    /// Each position is the entry index accepted by this artifact's `run`.
    pub entries: Vec<u64>,
    pub instruction_count: usize,
    pub block_count: usize,
    pub source_bytes: usize,
    pub source_ranges: Vec<SourceRange>,
    pub read_dependencies: Vec<SourceRange>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceRange {
    pub start: u64,
    pub length: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CompileError {
    Resource,
}

pub fn compile(image: &Image, entry: u64, limits: Limits) -> Result<Artifact, CompileError> {
    compile_with_context(image, &ExecutionContext::default(), entry, limits)
}

pub fn compile_with_context(
    image: &Image,
    context: &ExecutionContext,
    entry: u64,
    limits: Limits,
) -> Result<Artifact, CompileError> {
    compile_with_context_observed(image, context, entry, limits, false)
}

pub fn compile_with_context_observed(
    image: &Image,
    context: &ExecutionContext,
    entry: u64,
    limits: Limits,
    observed: bool,
) -> Result<Artifact, CompileError> {
    compile_with_paging(image, context, None, entry, limits, observed)
}

pub fn compile_with_paging(
    image: &Image,
    context: &ExecutionContext,
    paging: Option<&crate::x86::paging::State>,
    entry: u64,
    limits: Limits,
    observed: bool,
) -> Result<Artifact, CompileError> {
    let unit = discovery::discover_with_profile(image, context, paging, entry, limits)?;
    let bytes = wasm::emit_profile(&unit, observed, paging.is_some());
    if bytes.len() > limits.max_artifact_bytes as usize {
        return Err(CompileError::Resource);
    }
    Ok(Artifact {
        entries: unit
            .instructions
            .iter()
            .map(|instruction| instruction.pc)
            .collect(),
        instruction_count: unit.instructions.len(),
        block_count: unit.block_count,
        source_bytes: unit.source_bytes,
        source_ranges: unit.source_ranges,
        read_dependencies: unit.read_dependencies,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emitted_artifact_limit_is_checked_before_returning_an_artifact() {
        let image = Image::new(0x1000, vec![0xb8, 1, 0, 0, 0], 0x8000, vec![0; 8]).unwrap();
        let limits = Limits {
            max_instructions: 8,
            max_source_bytes: 32,
            max_artifact_bytes: 1,
        };
        assert!(matches!(
            compile(&image, 0x1000, limits),
            Err(CompileError::Resource)
        ));
        let artifact = compile(
            &image,
            0x1000,
            Limits {
                max_artifact_bytes: 65536,
                ..limits
            },
        )
        .unwrap();
        assert_eq!(artifact.entries, [0x1000]);
        assert_eq!(
            (
                artifact.instruction_count,
                artifact.block_count,
                artifact.source_bytes
            ),
            (1, 1, 5)
        );
        wasmparser::Validator::new()
            .validate_all(&artifact.bytes)
            .unwrap();
    }
}

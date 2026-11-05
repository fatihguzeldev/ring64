use super::address::span_failure;

#[derive(Debug)]
pub struct Image {
    pub(super) code: Span,
    pub(super) ram: Span,
}

#[derive(Debug)]
pub(super) struct Span {
    pub(super) base: u64,
    pub(super) bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Code,
    Ram,
}

impl Image {
    pub fn new(
        code_base: u64,
        code: Vec<u8>,
        ram_base: u64,
        ram: Vec<u8>,
    ) -> Result<Self, &'static str> {
        let code = Span::new(code_base, code)?;
        let ram = Span::new(ram_base, ram)?;
        if u128::from(code.base) < ram.end() && u128::from(ram.base) < code.end() {
            return Err("code and ram spans overlap");
        }
        Ok(Self { code, ram })
    }

    pub fn code_base(&self) -> u64 {
        self.code.base
    }

    pub fn code_len(&self) -> usize {
        self.code.bytes.len()
    }

    pub(super) fn locate(&self, address: u64) -> Option<(Kind, &Span)> {
        if self.code.contains(address) {
            Some((Kind::Code, &self.code))
        } else if self.ram.contains(address) {
            Some((Kind::Ram, &self.ram))
        } else {
            None
        }
    }
}

impl Span {
    fn new(base: u64, bytes: Vec<u8>) -> Result<Self, &'static str> {
        if bytes.is_empty() {
            return Err("memory spans must be nonempty");
        }
        if span_failure(base, bytes.len() as u128).is_some() {
            return Err("memory span must have a nonwrapping canonical48 address range");
        }
        Ok(Self { base, bytes })
    }

    pub(super) fn end(&self) -> u128 {
        u128::from(self.base) + self.bytes.len() as u128
    }

    fn contains(&self, address: u64) -> bool {
        u128::from(address) >= u128::from(self.base) && u128::from(address) < self.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_spans_can_end_at_the_last_u64_byte() {
        let image = Image::new(u64::MAX - 4, vec![0xb8, 0, 0, 0, 0], 0x1000, vec![0; 8]).unwrap();
        assert_eq!(image.code_base(), u64::MAX - 4);
        assert_eq!(image.code_len(), 5);
    }

    #[test]
    fn empty_spans_are_host_input_errors() {
        assert!(Image::new(0x1000, vec![], 0x2000, vec![0]).is_err());
        assert!(Image::new(0x1000, vec![0], 0x2000, vec![]).is_err());
    }

    #[test]
    fn wrapping_and_noncanonical_spans_are_host_input_errors() {
        for (base, bytes) in [
            (u64::MAX, vec![0; 2]),
            (0x0000_8000_0000_0000, vec![0]),
            (0x0000_7fff_ffff_ffff, vec![0; 2]),
            (0xffff_7fff_ffff_ffff, vec![0; 2]),
        ] {
            assert!(Image::new(base, bytes.clone(), 0x2000, vec![0]).is_err());
            assert!(Image::new(0x1000, vec![0], base, bytes).is_err());
        }
    }

    #[test]
    fn overlapping_spans_are_rejected_but_adjacent_spans_are_valid() {
        assert!(Image::new(0x1000, vec![0; 4], 0x1002, vec![0; 4]).is_err());
        assert!(Image::new(0x1002, vec![0; 4], 0x1000, vec![0; 4]).is_err());
        assert!(Image::new(0x1000, vec![0; 4], 0x1000, vec![0; 4]).is_err());
        assert!(Image::new(0x1000, vec![0; 4], 0x1004, vec![0; 4]).is_ok());
        assert!(Image::new(0x1004, vec![0; 4], 0x1000, vec![0; 4]).is_ok());
    }
}

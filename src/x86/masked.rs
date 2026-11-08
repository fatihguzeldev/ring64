pub struct Selection {
    fields: [(u32, u32); 8],
    count: usize,
}

impl Selection {
    pub fn fields(&self) -> &[(u32, u32)] {
        &self.fields[..self.count]
    }
}

pub fn select(bits: u16, width: u32) -> Selection {
    assert!(matches!(width, 8 | 16));
    let mut selection = Selection {
        fields: [(0, 0); 8],
        count: 0,
    };
    let mut remaining = u32::from(bits) & ((1 << width) - 1);
    while remaining != 0 {
        let start = remaining.trailing_zeros();
        let length = (remaining >> start).trailing_ones();
        selection.fields[selection.count] = (start, length);
        selection.count += 1;
        remaining &= !(((1 << length) - 1) << start);
    }
    selection
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selections_merge_adjacent_bytes_and_ignore_positions_outside_the_operand() {
        assert!(select(0, 16).fields().is_empty());
        assert_eq!(select(0xffff, 16).fields(), &[(0, 16)]);
        assert_eq!(select(0xffff, 8).fields(), &[(0, 8)]);
        assert_eq!(select(0xff00, 8).fields(), &[]);
        assert_eq!(select(0x8181, 16).fields(), &[(0, 1), (7, 2), (15, 1)]);
        assert_eq!(
            select(0x5555, 16).fields(),
            &[
                (0, 1),
                (2, 1),
                (4, 1),
                (6, 1),
                (8, 1),
                (10, 1),
                (12, 1),
                (14, 1)
            ]
        );
    }

    #[test]
    fn every_eight_and_sixteen_bit_mask_matches_independent_byte_selection() {
        let data: [u8; 16] = std::array::from_fn(|i| 0x10 + i as u8);
        for width in [8, 16] {
            for bits in 0..1u32 << width {
                let selection = select(bits as u16, width);
                let mut actual = [0xa5; 16];
                let mut previous_end = None;
                for &(start, length) in selection.fields() {
                    assert!(length > 0 && start + length <= width);
                    if let Some(end) = previous_end {
                        assert!(end < start);
                    }
                    previous_end = Some(start + length);
                    let range = start as usize..(start + length) as usize;
                    actual[range.clone()].copy_from_slice(&data[range]);
                }
                let expected = std::array::from_fn(|i| {
                    if i < width as usize && bits & (1 << i) != 0 {
                        data[i]
                    } else {
                        0xa5
                    }
                });
                assert_eq!(actual, expected, "width{width} mask{bits:04x}");
            }
        }
    }
}

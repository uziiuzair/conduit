//! Fractional index keys: given the keys of the two neighbours a card is being placed
//! between, produce a new key that sorts strictly between them. Moving a card rewrites
//! only its own file, so concurrent reorders by different teammates merge cleanly.
//!
//! Keys are byte strings over the contiguous ASCII range 0x30..=0x7a ('0'..='z'); plain
//! `<` / lexicographic ordering on the strings is the sort order. An empty string on the
//! left means "before the first card", on the right means "after the last card".

const LO: u8 = 0x30; // '0' — smallest allowed digit
const HI: u8 = 0x7a; // 'z' — largest allowed digit

/// Return a key `c` such that `a < c < b`, where `""` is treated as unbounded on that side.
/// Precondition: `a < b` (callers order neighbours before calling).
pub fn key_between(a: &str, b: &str) -> String {
    let av = a.as_bytes();
    let bv = b.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0usize;
    loop {
        let x = *av.get(i).unwrap_or(&LO);
        // `HI + 1` is an arithmetic sentinel for "b is unbounded here"; never emitted.
        let y = *bv.get(i).unwrap_or(&(HI + 1));
        if x == y {
            out.push(x);
            i += 1;
            continue;
        }
        let mid = x + (y - x) / 2;
        if mid > x {
            out.push(mid);
            return String::from_utf8(out).unwrap();
        }
        // Neighbours are adjacent at this position (y == x + 1): keep x and descend, with
        // the upper bound now effectively unbounded.
        out.push(x);
        i += 1;
        let a_rest = if i < av.len() {
            std::str::from_utf8(&av[i..]).unwrap()
        } else {
            ""
        };
        out.extend_from_slice(key_between(a_rest, "").as_bytes());
        return String::from_utf8(out).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ordered(a: &str, c: &str, b: &str) -> bool {
        (a.is_empty() || a < c) && (b.is_empty() || c < b)
    }

    #[test]
    fn between_two_empties_is_nonempty() {
        let k = key_between("", "");
        assert!(!k.is_empty());
    }

    #[test]
    fn first_and_last_bounds() {
        let first = key_between("", "U");
        assert!(first < "U".to_string());
        let last = key_between("U", "");
        assert!("U".to_string() < last);
    }

    #[test]
    fn strictly_between_adjacent_keys() {
        let a = "U";
        let b = "V";
        let c = key_between(a, b);
        assert!(ordered(a, &c, b), "expected {a} < {c} < {b}");
    }

    #[test]
    fn repeated_inserts_at_head_stay_ordered() {
        let mut head = key_between("", "");
        for _ in 0..20 {
            let next = key_between("", &head);
            assert!(next < head, "{next} !< {head}");
            head = next;
        }
    }

    #[test]
    fn repeated_inserts_in_the_same_gap_stay_ordered() {
        let a = "U".to_string();
        let b = "V".to_string();
        let mut lo = a.clone();
        for _ in 0..20 {
            let mid = key_between(&lo, &b);
            assert!(ordered(&lo, &mid, &b), "{lo} < {mid} < {b} failed");
            lo = mid;
        }
    }
}

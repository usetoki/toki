//! HPACK Huffman coding (RFC 7541 §5.2 + Appendix B). The encode side reads the
//! canonical code table directly; the decode side walks a binary trie built from that
//! same table at comptime, so the two can never drift. No allocation.

const std = @import("std");
const table = @import("huffman_table.zig");

pub const DecodeError = error{ BadHuffman, Overflow };

/// Octets needed to Huffman-encode `src` (code bits rounded up to a byte boundary).
pub fn encodedLen(src: []const u8) usize {
    var bits: usize = 0;
    for (src) |c| bits += table.code_len[c];
    return (bits + 7) / 8;
}

/// Encode `src` into `dest` (>= encodedLen). Trailing bits are padded with the MSBs of
/// the EOS code (all ones), per §5.2. Returns octets written.
pub fn encode(dest: []u8, src: []const u8) usize {
    var acc: u64 = 0;
    var nbits: u6 = 0;
    var p: usize = 0;
    for (src) |c| {
        const len: u6 = @intCast(table.code_len[c]);
        acc = (acc << len) | table.code[c];
        nbits += len;
        while (nbits >= 8) {
            nbits -= 8;
            dest[p] = @truncate(acc >> nbits);
            p += 1;
        }
        acc &= (@as(u64, 1) << nbits) - 1; // drop drained high bits so they can't bleed back
    }
    if (nbits > 0) {
        const pad: u6 = 8 - nbits;
        dest[p] = @truncate((acc << pad) | ((@as(u64, 1) << pad) - 1));
        p += 1;
    }
    return p;
}

const Node = struct { child: [2]i16 = .{ -1, -1 }, sym: i16 = -1 };

// 256 symbol leaves form a near-full binary trie; the dropped EOS leaf leaves a short
// all-ones spine of internal nodes. 600 slots covers it with margin.
const trie_cap = 600;
const trie = buildTrie();

fn buildTrie() [trie_cap]Node {
    @setEvalBranchQuota(50000);
    var nodes = [_]Node{.{}} ** trie_cap;
    var len: usize = 1; // node 0 is the root
    for (0..256) |sym| {
        const code = table.code[sym];
        var node: usize = 0;
        var i: u6 = @intCast(table.code_len[sym]);
        while (i > 0) {
            i -= 1;
            const bit: u1 = @intCast((code >> i) & 1);
            if (nodes[node].child[bit] == -1) {
                nodes[node].child[bit] = @intCast(len);
                len += 1;
            }
            node = @intCast(nodes[node].child[bit]);
        }
        nodes[node].sym = @intCast(sym);
    }
    return nodes;
}

/// Decode a Huffman string into `dest`, returning the decoded length. Rejects an
/// incomplete code, an embedded EOS, padding longer than 7 bits, or padding that is not
/// all ones (§5.2) — and overflow of `dest`.
pub fn decode(dest: []u8, src: []const u8) DecodeError!usize {
    var node: usize = 0; // root
    var out: usize = 0;
    var pad_bits: u32 = 0; // bits walked since the last emitted symbol
    var pad_ones = true; // were all of those bits set
    for (src) |byte| {
        var bi: u3 = 7;
        while (true) {
            const bit: u1 = @intCast((byte >> bi) & 1);
            const next = trie[node].child[bit];
            if (next == -1) return error.BadHuffman; // no such code (covers embedded EOS)
            node = @intCast(next);
            pad_bits += 1;
            if (bit == 0) pad_ones = false;
            if (trie[node].sym >= 0) {
                if (out >= dest.len) return error.Overflow;
                dest[out] = @intCast(trie[node].sym);
                out += 1;
                node = 0;
                pad_bits = 0;
                pad_ones = true;
            }
            if (bi == 0) break;
            bi -= 1;
        }
    }
    // a partial trailing code is only valid as EOS-prefix padding: all ones, <= 7 bits
    if (node != 0 and (!pad_ones or pad_bits > 7)) return error.BadHuffman;
    return out;
}

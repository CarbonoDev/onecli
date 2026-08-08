//! Path traversal (SECURITY).
//!
//! Shared by both extractors: a GitHub URL path and a Dropbox arg path are
//! equally unverifiable once they carry a dot-segment, for the same reason —
//! the string checked here is not the string the upstream resolves.

/// Whether a single `/`-delimited segment is a `.`/`..` dot-segment, including
/// its percent-encoded forms (`%2e`, `%2E`, `%2e%2e`, …). Decoded lossily so a
/// non-UTF-8 segment simply fails to match rather than panicking.
fn is_dot_segment(seg: &str) -> bool {
    let decoded = percent_encoding::percent_decode_str(seg).decode_utf8_lossy();
    decoded == "." || decoded == ".."
}

/// Whether a path contains any dot-segment. The forwarding layer builds the
/// upstream URL with the `url` crate, which collapses `.`/`..` (and their
/// `%2e` encodings) per WHATWG *before* the request is sent, so a scope check
/// run on the RAW request path would extract a resource from a path GitHub
/// never sees. Any such path is therefore treated as unverifiable (fail closed)
/// rather than parsed at face value.
pub(super) fn has_traversal(path: &str) -> bool {
    path.split('/').any(is_dot_segment)
}

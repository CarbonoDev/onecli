//! Test fixtures shared by more than one `scope` submodule's tests.

use crate::policy::MatchInput;

/// A `MatchInput` carrying only a buffered body.
pub(super) fn body_input(body: &[u8]) -> MatchInput<'_> {
    MatchInput {
        body: Some(body),
        body_truncated: false,
        headers: None,
    }
}

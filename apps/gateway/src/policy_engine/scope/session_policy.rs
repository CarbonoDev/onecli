//! Session-policy parsing: the stored `agent_app_connections.session_policy`
//! JSON value → a typed [`ResourceScope`], mirroring the API
//! `sessionPolicySchema` union `{repositories:[…]}` | `{folders:[…]}`.
//!
//! Nothing here decides a verdict; it only classifies the stored value into
//! "no scope" (`None`), a concrete resource list, or `Malformed`. The
//! fail-closed mapping of `Malformed` lives with the dispatch in the parent
//! module.

use serde_json::Value;

/// A parsed granular session policy. `Malformed` marks a scope that is present
/// but garbled (unknown key, non-string list, both keys, extra keys); it maps
/// to `Indeterminate` at evaluation so a garbled scope never reads as "all".
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ResourceScope {
    Repositories(Vec<String>),
    Folders(Vec<String>),
    Malformed,
}

/// Parse a stored `session_policy` value into a scope, mirroring the API
/// `sessionPolicySchema`. Returns `None` for "no scope" — an empty/absent
/// object, an empty `repositories`/`folders` list, `null`, or any non-object
/// (all mean "all resources", so the gate is a no-op). Returns
/// `Some(Malformed)` for a scope-present-but-garbled object.
pub(super) fn parse(sp: &Value) -> Option<ResourceScope> {
    let obj = sp.as_object()?; // non-object → unscoped
    if obj.is_empty() {
        return None; // {} → all
    }
    let has_repos = obj.contains_key("repositories");
    let has_folders = obj.contains_key("folders");
    match (has_repos, has_folders, obj.len()) {
        // Exactly one recognized key, nothing else — the strict union shape.
        (true, false, 1) => Some(match string_list(&obj["repositories"]) {
            ListShape::Values(v) => ResourceScope::Repositories(v),
            ListShape::Empty => return None, // empty list = all
            ListShape::Malformed => ResourceScope::Malformed,
        }),
        (false, true, 1) => Some(match string_list(&obj["folders"]) {
            ListShape::Values(v) => ResourceScope::Folders(v),
            ListShape::Empty => return None,
            ListShape::Malformed => ResourceScope::Malformed,
        }),
        // Unknown key, both keys, or extra keys alongside a recognized one.
        _ => Some(ResourceScope::Malformed),
    }
}

enum ListShape {
    Values(Vec<String>),
    Empty,
    Malformed,
}

/// A JSON value must be an array of strings. A non-array, or any non-string
/// element, is malformed (fail-closed); an empty array is "all".
fn string_list(v: &Value) -> ListShape {
    let Some(arr) = v.as_array() else {
        return ListShape::Malformed;
    };
    if arr.is_empty() {
        return ListShape::Empty;
    }
    let mut out = Vec::with_capacity(arr.len());
    for el in arr {
        match el.as_str() {
            Some(s) => out.push(s.to_string()),
            None => return ListShape::Malformed,
        }
    }
    ListShape::Values(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_recognizes_the_two_shapes() {
        assert_eq!(
            parse(&json!({"repositories": ["a/b"]})),
            Some(ResourceScope::Repositories(vec!["a/b".to_string()]))
        );
        assert_eq!(
            parse(&json!({"folders": ["/x"]})),
            Some(ResourceScope::Folders(vec!["/x".to_string()]))
        );
    }

    #[test]
    fn parse_treats_empty_and_absent_as_unscoped() {
        assert_eq!(parse(&json!({})), None);
        assert_eq!(parse(&json!({"repositories": []})), None);
        assert_eq!(parse(&json!({"folders": []})), None);
        assert_eq!(parse(&Value::Null), None);
        assert_eq!(parse(&json!(["a/b"])), None); // top-level array
        assert_eq!(parse(&json!("str")), None); // non-object
    }

    #[test]
    fn parse_flags_garbled_objects_as_malformed() {
        assert_eq!(
            parse(&json!({"unknownKey": ["x"]})),
            Some(ResourceScope::Malformed)
        );
        // Extra key alongside a recognized one.
        assert_eq!(
            parse(&json!({"repositories": ["a/b"], "folders": ["/x"]})),
            Some(ResourceScope::Malformed)
        );
        // Non-string list element.
        assert_eq!(
            parse(&json!({"repositories": [1, 2]})),
            Some(ResourceScope::Malformed)
        );
        // Value is not a list.
        assert_eq!(
            parse(&json!({"folders": "/x"})),
            Some(ResourceScope::Malformed)
        );
    }
}

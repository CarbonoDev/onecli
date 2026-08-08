//! GitHub (`github-app`, `github`) repository scoping: `{repositories:[…]}`.
//!
//! The repo is read from the URL path — `/repos/{owner}/{repo}` on
//! `api.github.com`, `/{owner}/{repo}(.git)?/…` for git-over-HTTPS and raw
//! content on any other GitHub host. Case-insensitive (GitHub repo names are).
//! Nothing here reads the request body: GitHub scoping is URL-only.

use super::path_safety::has_traversal;
use super::ScopeVerdict;

/// What repository, if any, a GitHub request path addresses.
enum RepoRef {
    /// `owner`, `repo` (repo case-folded at compare time).
    Repo(String, String),
    /// Account/search/meta endpoint — cannot name an out-of-scope repo.
    NotRepoAddressed,
    /// Repo-addressed but unverifiable at the URL layer (numeric id, GraphQL,
    /// a `/repos/` prefix we cannot split) — fail closed.
    Indeterminate,
}

pub(super) fn github_scope(host: &str, path: &str, allowed: &[String]) -> ScopeVerdict {
    match github_repo_ref(host, path) {
        RepoRef::Repo(owner, repo) => {
            if repo_in_scope(&owner, &repo, allowed) {
                ScopeVerdict::InScope
            } else {
                ScopeVerdict::OutOfScope
            }
        }
        RepoRef::NotRepoAddressed => ScopeVerdict::InScope,
        RepoRef::Indeterminate => ScopeVerdict::Indeterminate,
    }
}

fn github_repo_ref(host: &str, path: &str) -> RepoRef {
    // Drop query / fragment before splitting.
    let path = path.split(['?', '#']).next().unwrap_or(path);
    // A dot-segment (`.`/`..`, raw or `%2e`-encoded) is collapsed by the
    // forwarding layer's URL builder before the request reaches GitHub, so the
    // repo we would extract here is not the repo that gets served. Fail closed.
    if has_traversal(path) {
        return RepoRef::Indeterminate;
    }
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    if host == "api.github.com" {
        match segs.first().copied() {
            Some("repos") => match (segs.get(1), segs.get(2)) {
                (Some(owner), Some(repo)) if !owner.is_empty() && !repo.is_empty() => {
                    RepoRef::Repo((*owner).to_string(), (*repo).to_string())
                }
                // `/repos` or `/repos/{owner}` — repo-prefixed, no repo named.
                _ => RepoRef::Indeterminate,
            },
            // Numeric legacy id and GraphQL name the repo somewhere we can't
            // confine at the URL layer.
            Some("repositories") => RepoRef::Indeterminate,
            Some("graphql") => RepoRef::Indeterminate,
            // Everything else (`/user*`, `/orgs*`, `/search*`, `/rate_limit`,
            // `/installation/repositories`, `/meta`, root, …) cannot name an
            // out-of-scope repo (enumeration is bounded by GitHub's repo-scoped
            // installation token server-side).
            _ => RepoRef::NotRepoAddressed,
        }
    } else {
        // git-over-HTTPS (`github.com`) and raw content
        // (`raw.githubusercontent.com`): `/{owner}/{repo}(.git)?/…`.
        match (segs.first(), segs.get(1)) {
            (Some(owner), Some(repo)) if !owner.is_empty() && !repo.is_empty() => {
                let repo = repo.strip_suffix(".git").unwrap_or(repo);
                if repo.is_empty() {
                    RepoRef::Indeterminate
                } else {
                    RepoRef::Repo((*owner).to_string(), repo.to_string())
                }
            }
            // Fewer than two segments (root, `/settings`, …) → not a repo path.
            _ => RepoRef::NotRepoAddressed,
        }
    }
}

fn repo_in_scope(owner: &str, repo: &str, allowed: &[String]) -> bool {
    let target = format!(
        "{}/{}",
        owner.to_ascii_lowercase(),
        repo.to_ascii_lowercase()
    );
    allowed.iter().any(|a| a.to_ascii_lowercase() == target)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::{evaluate_scope, ScopeVerdict};
    use crate::policy::MatchInput;

    fn gh(host: &str, path: &str, allowed: &[&str]) -> ScopeVerdict {
        let scope = json!({ "repositories": allowed });
        evaluate_scope("github-app", host, Some(&scope), path, &MatchInput::empty())
    }

    #[test]
    fn github_in_and_out_of_scope_by_repo() {
        assert_eq!(
            gh("api.github.com", "/repos/acme/app/pulls", &["acme/app"]),
            ScopeVerdict::InScope
        );
        assert_eq!(
            gh("api.github.com", "/repos/acme/app/pulls", &["acme/other"]),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn github_is_case_insensitive() {
        assert_eq!(
            gh("api.github.com", "/repos/ACME/App", &["acme/app"]),
            ScopeVerdict::InScope
        );
    }

    #[test]
    fn github_git_over_https_path() {
        assert_eq!(
            gh("github.com", "/acme/app.git/info/refs", &["acme/app"]),
            ScopeVerdict::InScope
        );
        assert_eq!(
            gh("github.com", "/acme/app.git/info/refs", &["acme/other"]),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn github_raw_content_host_is_repo_addressed() {
        assert_eq!(
            gh(
                "raw.githubusercontent.com",
                "/acme/app/main/README.md",
                &["acme/app"]
            ),
            ScopeVerdict::InScope
        );
        assert_eq!(
            gh(
                "raw.githubusercontent.com",
                "/acme/secret/main/x",
                &["acme/app"]
            ),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn github_account_endpoints_are_in_scope() {
        for path in [
            "/user/repos",
            "/orgs/acme/repos",
            "/rate_limit",
            "/",
            "/meta",
        ] {
            assert_eq!(
                gh("api.github.com", path, &["acme/app"]),
                ScopeVerdict::InScope,
                "account endpoint {path} must not be repo-scoped"
            );
        }
    }

    #[test]
    fn github_unverifiable_repo_references_are_indeterminate() {
        assert_eq!(
            gh("api.github.com", "/repositories/12345", &["acme/app"]),
            ScopeVerdict::Indeterminate
        );
        assert_eq!(
            gh("api.github.com", "/graphql", &["acme/app"]),
            ScopeVerdict::Indeterminate
        );
        // `/repos/` prefix with no repo named.
        assert_eq!(
            gh("api.github.com", "/repos/acme", &["acme/app"]),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn github_dot_segment_traversal_fails_closed() {
        // The forwarding layer's URL builder collapses `..` before the request
        // reaches GitHub, so a raw path that prefixes an in-scope repo but
        // traverses out of it must NOT read as in scope. Both API and git hosts.
        assert_eq!(
            gh(
                "api.github.com",
                "/repos/acme/app/../../evil/target/contents/secret",
                &["acme/app"]
            ),
            ScopeVerdict::Indeterminate
        );
        // Percent-encoded dot-segments are collapsed identically.
        assert_eq!(
            gh(
                "api.github.com",
                "/repos/acme/app/%2e%2e/%2e%2e/evil/repo",
                &["acme/app"]
            ),
            ScopeVerdict::Indeterminate
        );
        assert_eq!(
            gh(
                "github.com",
                "/acme/app/../../evil/repo.git/info/refs",
                &["acme/app"]
            ),
            ScopeVerdict::Indeterminate
        );
    }
}

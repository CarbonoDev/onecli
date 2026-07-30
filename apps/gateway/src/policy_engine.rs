//! Policy engine — the OSS project-level first-match core (step 9.5). The EE
//! editions (cloud + both onprems) swap this module for `ee/policy_engine.rs`
//! via `#[path]` in `main.rs`; the `pub(crate)` surface is identical in both
//! builds, so the shared call sites in `connect.rs`, `gateway/forward.rs`, and
//! `gateway/websocket.rs` never change.
//!
//! The OSS scope: org + project rules composed two-level (each level reduced
//! first-match, combined under the hard-floor law mirroring
//! `policy-translation/evaluator.ts`), agent/user/group/any identities (the
//! directory kinds matched against the connection's resolved `PrincipalSet`),
//! all four target kinds, allow/block with the approval + rate-limit modifiers,
//! each level's Default Rule terminal under the `enforce_deny` carve, and the
//! explicit-agent injection selection its equipment migration requires. There
//! is no agent-group concept (deleted). Granular session-policy conditions,
//! app availability, and the shadow comparator remain OneCLI Cloud
//! capabilities and have no code here.

mod assemble;
mod catalog;
mod enforce;
mod evaluate;
mod inject_select;
mod loaders;
mod types;

// The corpus parity test lives in the PRIVATE tree (`src/ee/policy_engine/`)
// and never ships: it proves this core decision-identical to the EE engine's
// project arm over the golden corpus. Compiled only in `edition_oss` test
// builds (this root is only compiled there); the OSS repo carries an empty
// stub at the same path so `cargo fmt`/`cargo test` resolve it.
#[cfg(test)]
#[path = "ee/policy_engine/oss_parity_test.rs"]
mod oss_parity_test;

pub(crate) use enforce::{evaluate, load_available_apps, load_connect_v2, needs_body_buffer};
pub(crate) use inject_select::derive_inject_selection;

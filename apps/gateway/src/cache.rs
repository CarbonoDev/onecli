//! Generic key-value cache with TTL.
//!
//! OSS uses an in-memory `DashMap` backend. Cloud swaps this module
//! via `#[cfg(edition_cloud)]` to use Redis.
//!
//! All values are serialized to JSON — the `CacheStore` trait is
//! type-agnostic. Consumers use namespaced keys to avoid collisions
//! (e.g., `connect:{token}:{host}`, `cred:{user}:{host}`).

use std::time::{Duration, Instant};

use async_trait::async_trait;
use dashmap::DashMap;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tracing::warn;

/// Generic key-value cache with TTL.
///
/// Implementations must be `Send + Sync` for use in async contexts.
/// Values are serialized to JSON internally — callers work with
/// concrete types via serde.
///
/// Uses `async_trait` for dyn-compatibility (`Arc<dyn CacheStore>`).
#[async_trait]
pub(crate) trait CacheStore: Send + Sync {
    /// Get a value by key. Returns `None` on miss or expiry.
    async fn get_raw(&self, key: &str) -> Option<String>;

    /// Set a raw string value with a TTL in seconds.
    async fn set_raw(&self, key: &str, value: &str, ttl_secs: u64);

    /// Delete a key.
    #[allow(dead_code)]
    async fn del(&self, key: &str);

    /// Delete all keys matching a prefix.
    async fn del_by_prefix(&self, prefix: &str);

    /// Atomically increment a counter at `key`.
    /// Sets TTL only on first increment (new key / expired key).
    /// Returns the new count, or `None` on error (graceful fallback).
    async fn incr(&self, key: &str, ttl_secs: u64) -> Option<u64>;

    /// Add `delta` to a signed counter, returning the new total.
    ///
    /// Distinct from [`incr`], which is a +1 rate-limit counter over `u64`.
    /// Spend counters are signed nano-dollar totals and move by a per-request
    /// amount, so they need their own primitive rather than a loop over `incr`.
    ///
    /// Atomic per key: the read-modify-write happens under the entry lock, so
    /// concurrent charges against one budget accumulate instead of racing on a
    /// read-then-set. That is the whole point of having it — a
    /// `get_raw`/`set_raw` pair would lose every charge but the last.
    async fn incr_by(&self, key: &str, delta: i64, ttl_secs: u64) -> Option<i64>;
}

/// Extension methods for typed get/set on any `CacheStore`.
impl dyn CacheStore + '_ {
    /// Get a typed value by key.
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let raw = self.get_raw(key).await?;
        match serde_json::from_str(&raw) {
            Ok(val) => Some(val),
            Err(e) => {
                warn!(key, error = %e, "cache deserialization failed, treating as miss");
                None
            }
        }
    }

    /// Set a typed value with TTL.
    pub async fn set<T: Serialize>(&self, key: &str, value: &T, ttl_secs: u64) {
        match serde_json::to_string(value) {
            Ok(raw) => self.set_raw(key, &raw, ttl_secs).await,
            Err(e) => warn!(key, error = %e, "cache serialization failed, value not cached"),
        }
    }
}

/// Create the cache store for this build.
/// OSS: in-memory DashMap. Cloud: Redis (swapped via `#[cfg]`).
pub(crate) async fn create_store() -> anyhow::Result<std::sync::Arc<dyn CacheStore>> {
    Ok(std::sync::Arc::new(InMemoryCacheStore::new()))
}

// ── In-memory implementation ─────────────────────────────────────────────

struct CachedEntry {
    data: String,
    expires_at: Instant,
}

/// In-memory cache backed by `DashMap`. Used in OSS (single-instance).
///
/// Expired entries are evicted lazily on read — no background reaper.
/// Acceptable for the gateway's bounded key space (one entry per
/// agent×host pair), but not suitable for unbounded key sets.
struct InMemoryCacheStore {
    map: DashMap<String, CachedEntry>,
}

impl InMemoryCacheStore {
    pub fn new() -> Self {
        Self {
            map: DashMap::new(),
        }
    }
}

#[async_trait]
impl CacheStore for InMemoryCacheStore {
    async fn get_raw(&self, key: &str) -> Option<String> {
        let entry = self.map.get(key)?;
        if entry.expires_at > Instant::now() {
            Some(entry.data.clone())
        } else {
            drop(entry);
            self.map.remove(key);
            None
        }
    }

    async fn set_raw(&self, key: &str, value: &str, ttl_secs: u64) {
        let now = Instant::now();
        let expires_at = now
            .checked_add(Duration::from_secs(ttl_secs))
            .unwrap_or(now + Duration::from_secs(86_400 * 365));

        self.map.insert(
            key.to_string(),
            CachedEntry {
                data: value.to_string(),
                expires_at,
            },
        );
    }

    async fn del(&self, key: &str) {
        self.map.remove(key);
    }

    async fn del_by_prefix(&self, prefix: &str) {
        self.map.retain(|key, _| !key.starts_with(prefix));
    }

    async fn incr(&self, key: &str, ttl_secs: u64) -> Option<u64> {
        let now = Instant::now();
        let ttl = Duration::from_secs(ttl_secs);

        let mut entry = self.map.entry(key.to_string()).or_insert(CachedEntry {
            data: "0".to_string(),
            expires_at: now + ttl,
        });

        // Reset if expired
        if entry.expires_at <= now {
            entry.data = "0".to_string();
            entry.expires_at = now + ttl;
        }

        let count: u64 = entry.data.parse().unwrap_or(0) + 1;
        entry.data = count.to_string();
        Some(count)
    }

    async fn incr_by(&self, key: &str, delta: i64, ttl_secs: u64) -> Option<i64> {
        let now = Instant::now();
        let ttl = Duration::from_secs(ttl_secs);

        // `entry` holds the shard lock for the whole read-modify-write, so two
        // concurrent charges on one budget cannot both read the same total.
        let mut entry = self.map.entry(key.to_string()).or_insert(CachedEntry {
            data: "0".to_string(),
            expires_at: now + ttl,
        });

        if entry.expires_at <= now {
            entry.data = "0".to_string();
            entry.expires_at = now + ttl;
        }

        // An unparseable value is treated as 0 rather than propagating: this is
        // a cache, and the durable BudgetSpend row is the floor that corrects it.
        let total = entry.data.parse::<i64>().unwrap_or(0).saturating_add(delta);
        entry.data = total.to_string();
        // Refresh the window on write so an actively-charged period never
        // expires mid-period.
        entry.expires_at = now + ttl;
        Some(total)
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Helper: create a store as `Arc<dyn CacheStore>` to test the dyn path.
    fn new_store() -> Arc<dyn CacheStore> {
        Arc::new(InMemoryCacheStore::new())
    }

    #[tokio::test]
    async fn get_returns_none_on_miss() {
        let store = new_store();
        let result: Option<String> = store.get("missing").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn set_and_get_round_trip() {
        let store = new_store();
        store.set("key1", &"hello", 60).await;
        let result: Option<String> = store.get("key1").await;
        assert_eq!(result.as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn get_returns_none_after_expiry() {
        let store = new_store();
        store.set("key1", &42u64, 0).await;
        // TTL=0 means already expired
        let result: Option<u64> = store.get("key1").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn incr_by_accumulates_concurrent_charges() {
        // THE POINT OF incr_by. A get_raw/set_raw pair would let two concurrent
        // charges both read 0 and both write their own delta, keeping only the
        // last — which is exactly how spend used to slip past a cap.
        let store = new_store();
        let key = "budget:spent:sec:org:m:2026-08";

        let tasks: Vec<_> = (0..64)
            .map(|_| {
                let store = Arc::clone(&store);
                let key = key.to_string();
                tokio::spawn(async move { store.incr_by(&key, 1_000, 60).await })
            })
            .collect();
        for t in tasks {
            t.await.unwrap();
        }

        let total: i64 = store.get_raw(key).await.unwrap().parse().unwrap();
        assert_eq!(total, 64_000, "every concurrent charge must be counted");
    }

    #[tokio::test]
    async fn incr_by_starts_from_zero_and_survives_a_set_floor() {
        let store = new_store();
        let key = "budget:spent:sec:org:total";

        assert_eq!(store.incr_by(key, 250, 60).await, Some(250));
        // A durable floor arriving from PostgreSQL, then more charges on top.
        store.set_raw(key, "1000", 60).await;
        assert_eq!(store.incr_by(key, 25, 60).await, Some(1025));
    }

    #[tokio::test]
    async fn incr_by_treats_an_unparseable_value_as_zero() {
        // The counter shares a namespace with JSON-valued caches; a stray value
        // must not poison spend accounting. The durable row is the floor.
        let store = new_store();
        store.set_raw("budget:spent:x", "not-a-number", 60).await;
        assert_eq!(store.incr_by("budget:spent:x", 7, 60).await, Some(7));
    }

    #[tokio::test]
    async fn del_removes_entry() {
        let store = new_store();
        store.set("key1", &"value", 60).await;
        store.del("key1").await;
        let result: Option<String> = store.get("key1").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn del_by_prefix_removes_matching_entries() {
        let store = new_store();
        store.set("connect:acc1:tok1:host1", &"v1", 60).await;
        store.set("connect:acc1:tok2:host2", &"v2", 60).await;
        store.set("connect:acc2:tok3:host3", &"v3", 60).await;
        store.set("rate:rule1:tok1:123", &"1", 60).await;

        store.del_by_prefix("connect:acc1:").await;

        assert!(store
            .get::<String>("connect:acc1:tok1:host1")
            .await
            .is_none());
        assert!(store
            .get::<String>("connect:acc1:tok2:host2")
            .await
            .is_none());
        assert_eq!(
            store
                .get::<String>("connect:acc2:tok3:host3")
                .await
                .as_deref(),
            Some("v3")
        );
        assert_eq!(
            store.get::<String>("rate:rule1:tok1:123").await.as_deref(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn typed_round_trip() {
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
        struct MyData {
            name: String,
            count: u32,
        }

        let store = new_store();
        let data = MyData {
            name: "test".to_string(),
            count: 42,
        };
        store.set("typed", &data, 60).await;
        let result: Option<MyData> = store.get("typed").await;
        assert_eq!(result, Some(data));
    }
}

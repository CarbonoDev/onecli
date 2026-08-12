export type PageScope = "project" | "organization";

/** Scoped apps API base: /v1/apps{sub} on project pages, /v1/org/apps{sub} on org pages. */
export const appsPath = (scope: PageScope, sub = "") =>
  scope === "organization" ? `/v1/org/apps${sub}` : `/v1/apps${sub}`;

/**
 * Scoped secrets API base: /v1/secrets{sub} on project pages,
 * /v1/org/secrets{sub} on org pages.
 *
 * The org router is admin-gated (`role: "admin"`), so every read and write
 * through it 403s deterministically for a plain member — callers render that,
 * they do not retry it.
 */
export const secretsPath = (scope: PageScope, sub = "") =>
  scope === "organization" ? `/v1/org/secrets${sub}` : `/v1/secrets${sub}`;

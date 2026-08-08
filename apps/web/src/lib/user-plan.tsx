"use server";

/** OSS default: no redirect needed. The EE editions override this via turbopack alias. */
export const checkDashboardRedirect = async (): Promise<string | null> => null;

/**
 * This build is fully entitled — mirrors what on-prem reports via
 * ONPREM_ENTITLEMENT_ALIASES (`next.config.js`), so plan-gated apps and
 * features are never shown as locked. The EE editions override this via
 * turbopack alias.
 */
export const getCurrentPlan = async (): Promise<string | null> => "enterprise";

/**
 * The webhook template language.
 *
 * `{{a.b.0.c}}` dot paths over the parsed payload, plus a handful of `{{$…}}`
 * specials. That is the entire grammar: there are no conditionals, no loops,
 * and — deliberately — no `eval`, no `new Function`, and no code path that
 * treats template text as anything but a literal. A template is written by a
 * project member but rendered over an attacker-controlled payload, so the only
 * safe posture is a substitution that cannot express computation.
 *
 * Rendering happens at INGEST, not at claim time: the claim path stays a pure
 * indexed queue read, and `renderedText` becomes the record of what the agent
 * was actually told rather than a reconstruction. Replay re-renders with the
 * endpoint's *current* template into a new row, which is how template edits get
 * picked up.
 */

import {
  RENDER_MAX_OUTPUT,
  RENDER_MAX_RAW,
  RENDER_MAX_VALUE,
} from "./constants";

export interface RenderContext {
  /** The parsed payload. `unknown` — a provider may send any JSON value. */
  payload: unknown;
  /** The raw body as text, for `{{$raw}}`. */
  rawBody: string;
  slug: string;
  event: string | null;
  deliveryId: string;
}

export interface RenderResult {
  text: string;
  /**
   * Placeholders that resolved to nothing. Persisted on the delivery so a
   * broken template is visible in the UI without diffing the payload by hand.
   */
  unresolved: string[];
  truncated: boolean;
}

export const DEFAULT_TEMPLATE = "[{{$slug}}] {{$event}}\n\n{{$raw}}";

/**
 * The only thing interpreted. A name must start with a letter, digit, `_` or
 * `$`, so `{{ bad name }}`, `{{`, and a JSON object in the template text all
 * pass through untouched.
 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_$][A-Za-z0-9_$.-]*)\s*\}\}/g;

/**
 * Segments that would climb the prototype chain. Blocked even though the walk
 * below also requires an own property, because a JSON payload really can carry
 * a literal `__proto__` key and belt-and-braces is cheap here.
 */
const BLOCKED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Drop C0 control characters and DEL, keeping the two that carry meaning in
 * text (tab and newline). Payload text ends up in an LLM prompt: framing it is
 * the consumer's job, encoding hygiene is ours.
 */
// Matching control characters is the entire purpose here — they are what is
// being removed.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const stripControlChars = (value: string): string =>
  value.replace(CONTROL_CHARS_RE, "");

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** Walk a dot path over the payload, refusing anything but own properties. */
const resolvePath = (payload: unknown, path: string): unknown => {
  let node: unknown = payload;
  for (const segment of path.split(".")) {
    if (segment === "" || BLOCKED_SEGMENTS.has(segment)) return undefined;
    if (node === null || typeof node !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
};

/**
 * Path values are capped here rather than at the call site, so the specials —
 * which carry their own, larger caps — are not silently re-truncated.
 */
const stringifyValue = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(value, RENDER_MAX_VALUE);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "object") {
    try {
      return truncate(JSON.stringify(value) ?? "", RENDER_MAX_VALUE);
    } catch {
      // Circular structures can't come from JSON.parse, but the payload also
      // arrives from a replay round-trip — fail soft rather than throw.
      return null;
    }
  }
  return null;
};

const resolveSpecial = (name: string, ctx: RenderContext): string | null => {
  switch (name) {
    case "$raw":
      return truncate(ctx.rawBody, RENDER_MAX_RAW);
    case "$slug":
      return ctx.slug;
    case "$event":
      return ctx.event;
    case "$delivery_id":
      return ctx.deliveryId;
    default:
      return null;
  }
};

export const renderTemplate = (
  template: string,
  ctx: RenderContext,
): RenderResult => {
  const source = template.trim() === "" ? DEFAULT_TEMPLATE : template;
  const unresolved = new Set<string>();

  const substituted = source.replace(PLACEHOLDER_RE, (_match, rawName) => {
    const name = String(rawName);
    const value = name.startsWith("$")
      ? resolveSpecial(name, ctx)
      : stringifyValue(resolvePath(ctx.payload, name));

    if (value === null || value === "") {
      unresolved.add(name);
      return "";
    }
    return value;
  });

  const cleaned = stripControlChars(substituted).replace(/\n{3,}/g, "\n\n");
  const truncated = cleaned.length > RENDER_MAX_OUTPUT;

  return {
    text: truncated
      ? `${cleaned.slice(0, RENDER_MAX_OUTPUT)}\n…[truncated]`
      : cleaned,
    unresolved: [...unresolved],
    truncated,
  };
};

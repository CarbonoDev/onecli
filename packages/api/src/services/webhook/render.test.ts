import { describe, expect, it } from "vitest";

import {
  RENDER_MAX_OUTPUT,
  RENDER_MAX_RAW,
  RENDER_MAX_VALUE,
} from "./constants";
import { DEFAULT_TEMPLATE, renderTemplate, type RenderContext } from "./render";

const ctx = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  payload: {},
  rawBody: "{}",
  slug: "gh-issues",
  event: "issues.opened",
  deliveryId: "d-1",
  ...overrides,
});

const render = (template: string, overrides: Partial<RenderContext> = {}) =>
  renderTemplate(template, ctx(overrides));

describe("renderTemplate — paths", () => {
  it("substitutes a top-level key", () => {
    expect(render("hi {{name}}", { payload: { name: "ada" } }).text).toBe(
      "hi ada",
    );
  });

  it("walks a nested path", () => {
    const payload = { repository: { owner: { login: "acme" } } };
    expect(render("{{repository.owner.login}}", { payload }).text).toBe("acme");
  });

  it("indexes into arrays with numeric segments", () => {
    const payload = { commits: [{ message: "first" }, { message: "second" }] };
    expect(render("{{commits.1.message}}", { payload }).text).toBe("second");
  });

  it("renders numbers and booleans", () => {
    const payload = { number: 42, draft: false };
    expect(render("#{{number}} draft={{draft}}", { payload }).text).toBe(
      "#42 draft=false",
    );
  });

  it("JSON-encodes object and array values", () => {
    const payload = { labels: ["bug", "p0"] };
    expect(render("{{labels}}", { payload }).text).toBe('["bug","p0"]');
  });

  it("reports a missing path as unresolved and renders empty", () => {
    const result = render("[{{nope.deep}}]", { payload: { nope: {} } });
    expect(result.text).toBe("[]");
    expect(result.unresolved).toEqual(["nope.deep"]);
  });

  it("treats a null value as unresolved", () => {
    const result = render("{{merged_by}}", { payload: { merged_by: null } });
    expect(result.text).toBe("");
    expect(result.unresolved).toEqual(["merged_by"]);
  });

  it("does not descend into a non-object", () => {
    const result = render("{{title.length}}", { payload: { title: "hello" } });
    expect(result.text).toBe("");
    expect(result.unresolved).toEqual(["title.length"]);
  });

  it("deduplicates repeated unresolved placeholders", () => {
    expect(render("{{a}} {{a}} {{b}}").unresolved).toEqual(["a", "b"]);
  });
});

describe("renderTemplate — specials", () => {
  it("renders $slug, $event and $delivery_id", () => {
    expect(render("{{$slug}}/{{$event}}/{{$delivery_id}}").text).toBe(
      "gh-issues/issues.opened/d-1",
    );
  });

  it("renders $raw as the exact request body text", () => {
    const rawBody = '{"a":1,"b":"x"}';
    expect(render("{{$raw}}", { rawBody }).text).toBe(rawBody);
  });

  it("treats a null event as unresolved rather than printing null", () => {
    const result = render("event={{$event}}", { event: null });
    expect(result.text).toBe("event=");
    expect(result.unresolved).toEqual(["$event"]);
  });

  it("falls back to the default template when blank", () => {
    const explicit = render(DEFAULT_TEMPLATE);
    expect(render("   ").text).toBe(explicit.text);
  });
});

describe("renderTemplate — prototype safety", () => {
  it("refuses __proto__ and constructor segments", () => {
    const result = render("[{{__proto__.polluted}}][{{constructor.name}}]");
    expect(result.text).toBe("[][]");
    expect({}).not.toHaveProperty("polluted");
  });

  // JSON.parse creates a literal own "__proto__" key rather than touching the
  // prototype — the segment blocklist is what keeps it unreachable.
  it("cannot reach a payload key literally named __proto__", () => {
    const payload = JSON.parse('{"__proto__":{"polluted":"yes"}}') as unknown;
    expect(render("{{__proto__.polluted}}", { payload }).text).toBe("");
  });
});

describe("renderTemplate — literals and hygiene", () => {
  it("leaves non-placeholder braces untouched", () => {
    const template = 'body: { "a": 1 } {{ bad name }} {{ and {{';
    expect(render(template).text).toBe(template);
  });

  it("strips control characters but keeps tabs and newlines", () => {
    const payload = { note: "a\u0000b\u0007c\td\ne" };
    expect(render("{{note}}", { payload }).text).toBe("abc\td\ne");
  });

  it("collapses long newline runs", () => {
    const payload = { note: "a\n\n\n\n\nb" };
    expect(render("{{note}}", { payload }).text).toBe("a\n\nb");
  });
});

describe("renderTemplate — caps", () => {
  it("truncates a single oversized value", () => {
    const payload = { blob: "x".repeat(RENDER_MAX_VALUE * 2) };
    const { text } = render("{{blob}}", { payload });
    expect(text).toHaveLength(RENDER_MAX_VALUE + 1); // + the ellipsis
    expect(text.endsWith("…")).toBe(true);
  });

  it("truncates $raw independently of the output cap", () => {
    const rawBody = "y".repeat(RENDER_MAX_RAW * 2);
    const { text } = render("{{$raw}}", { rawBody });
    expect(text).toHaveLength(RENDER_MAX_RAW + 1);
  });

  it("truncates the whole output and flags it", () => {
    const template = "z".repeat(RENDER_MAX_OUTPUT + 100);
    const result = render(template);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("\n…[truncated]")).toBe(true);
  });

  it("does not flag output at the cap", () => {
    expect(render("z".repeat(RENDER_MAX_OUTPUT)).truncated).toBe(false);
  });
});

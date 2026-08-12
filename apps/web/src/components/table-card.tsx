import * as React from "react";
import { Card } from "@onecli/ui/components/card";
import { cn } from "@onecli/ui/lib/utils";

/**
 * The org-spec table header treatment: uppercase, ~11px, letter-spaced, gray.
 *
 * Escape hatch for tables that can't use the `TableCard` frame — pass it as
 * `className` on each `TableHead`, where `TableHead`'s own `cn()` merges it
 * deterministically over the built-in `text-foreground`.
 *
 * Kept deliberately in sync BY HAND with `TABLE_HEAD_VARIANTS` below. Deriving
 * one from the other would break Tailwind's static class extraction, which
 * only works because both literals appear verbatim in the source. Edit one,
 * edit the other.
 */
export const TABLE_HEAD_CLASS =
  "text-muted-foreground text-[11px] font-medium tracking-wider uppercase";

// The same treatment applied from the outside, as descendant utility variants.
// `packages/ui` is shadcn territory and stays untouched: CLAUDE.md permits both
// "customizing via className" and "wrapping in your own component", so the
// wrapper styles TableHead from the ancestor. These compile to
// `.\[\&_thead_th\]\:… thead th`, a (0,1,2) selector, which outranks
// TableHead's own (0,1,0) `.text-foreground` on specificity.
//
// The cost of winning that way: inside a TableCard, a `<TableHead
// className="...">` CANNOT override color, font-size, letter-spacing,
// text-transform or font-weight — it's a (0,1,0) class losing to this
// (0,1,2) rule, and `tailwind-merge` can't warn or dedupe because the conflict
// is cross-element. A header needing its own value for one of those five must
// live outside the TableCard frame and use TABLE_HEAD_CLASS instead.
// TableHead classNames for width, alignment, etc. are unaffected.
const TABLE_HEAD_VARIANTS =
  "[&_thead_th]:text-muted-foreground [&_thead_th]:text-[11px] [&_thead_th]:font-medium [&_thead_th]:tracking-wider [&_thead_th]:uppercase";

/**
 * Card frame for a borderless, card-wrapped table. Children are the `<Table>`
 * tree, unchanged.
 */
export const TableCard = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <Card
    className={cn("gap-0 overflow-hidden p-0", TABLE_HEAD_VARIANTS, className)}
    {...props}
  />
);

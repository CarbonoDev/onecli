"use client";

import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { BookOpen, Moon, Sun } from "lucide-react";
import { SidebarTrigger } from "@onecli/ui/components/sidebar";
import { Separator } from "@onecli/ui/components/separator";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@onecli/ui/components/breadcrumb";
import {
  isPathUnderNavItem,
  navBreadcrumbLabel,
  navItemsForShell,
} from "@/lib/nav-config";
import type { NavItem } from "./nav-main";
import {
  useCurrentOrganizationId,
  useOrganizationsList,
} from "@/hooks/use-organizations";
import { useNavShell } from "@/hooks/use-nav-shell";
import { useCurrentProjectId, useProjectsList } from "@/hooks/use-projects";
import { GetStartedButton } from "./get-started-button";
import { ApprovalsBell } from "@/lib/components/approvals";

/** A rendered breadcrumb entry. The last one is the current page; earlier ones
 * link, except where `href` is dropped because the destination would be a
 * no-op (see `crumbs` below). */
interface Crumb {
  label: string;
  href?: string;
}

/**
 * Every `/settings/*` page crumbs as `Settings › <rail title>`, whichever nav
 * list also claims it. Eight sibling pages render the same settings rail; the
 * sidebar's "Organization Settings" / "Project Settings" labels would give
 * three different crumb shapes for one screen.
 *
 * `url` is for path math only — the crumb is NOT linked. `/settings` is a
 * redirect to the first rail entry, so following it from `/settings/profile`
 * would land on `/settings/project` and flip the whole sidebar into project
 * scope.
 */
const SETTINGS_FALLBACK: Pick<NavItem, "title" | "url"> = {
  title: "Settings",
  url: "/settings",
};

const GitHubIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

const DiscordIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
  </svg>
);

export const DashboardHeader = () => {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();

  // The same hook the sidebar uses, so nav and breadcrumb agree on the shell.
  const shell = useNavShell();

  // Same react-query keys the sidebar switchers already subscribe to, so the
  // org and project crumbs cost no extra request. Both resolve after
  // hydration; each crumb renders only once its name is known rather than
  // flashing a placeholder.
  const organizationId = useCurrentOrganizationId();
  const { data: organizations } = useOrganizationsList();
  const organizationName = organizations?.find(
    (org) => org.id === organizationId,
  )?.name;

  const projectId = useCurrentProjectId();
  const { data: projects } = useProjectsList();
  const project = projects?.find((p) => p.id === projectId);
  const projectName = project?.name ?? project?.slug;

  // Settings is checked FIRST so all eight rail pages crumb identically, even
  // the two a nav list also names. Everywhere else the longest nav match wins.
  const isSettings = isPathUnderNavItem(pathname, SETTINGS_FALLBACK.url);
  const navItem = isSettings
    ? SETTINGS_FALLBACK
    : navItemsForShell(shell)
        .filter((item) => isPathUnderNavItem(pathname, item.url))
        .sort((a, b) => b.url.length - a.url.length)[0];

  const subPath = navItem
    ? pathname.slice(navItem.url.length).replace(/^\//, "")
    : "";
  // Opaque resource ids (uuid detail segments, e.g. /agents/<id>) would
  // title-case into gibberish — drop them; the page's own header names the
  // resource. The digit requirement keeps long PROVIDER slugs (all letters,
  // e.g. a 16-char app id) rendering as crumbs.
  const subSegments = (subPath ? subPath.split("/") : []).filter(
    (s) => !(/^[a-z0-9-]{16,}$/i.test(s) && /\d/.test(s)),
  );

  const formatSegment = (s: string) =>
    s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");

  // Org › [All projects › Project ›] Page › Sub-page. Every crumb whose text
  // comes from the network is omitted until it has one — never stubbed, and
  // never half-shown: the project group appears atomically, so the first paint
  // of `/overview` doesn't read "All projects › Overview" (which describes a
  // different page) before the names land.
  const crumbs: Crumb[] = [];
  if (organizationName) {
    crumbs.push({ label: organizationName, href: "/projects" });
  }
  if (shell === "project" && projectName) {
    crumbs.push({ label: "All projects", href: "/projects" });
    crumbs.push({ label: projectName, href: "/overview" });
  }
  if (navItem) {
    crumbs.push({
      // The crumb label, not the sidebar label: the nav item reads "Projects"
      // (a section), the crumb reads "All projects" (the place you go back to).
      label: navBreadcrumbLabel(navItem.url) ?? navItem.title,
      // `Settings` is a section header, not a destination — see
      // `SETTINGS_FALLBACK`.
      href: isSettings ? undefined : navItem.url,
    });
    subSegments.forEach((segment, i) => {
      const href = `${navItem.url}/${subSegments.slice(0, i + 1).join("/")}`;
      // Prefer the label the nav already declares for this exact path — that
      // is what turns `/settings/api-keys` into "API Keys" instead of the
      // title-cased slug "Api keys".
      crumbs.push({
        label: navBreadcrumbLabel(href) ?? formatSegment(segment),
        href,
      });
    });
  } else {
    crumbs.push({ label: "Dashboard" });
  }

  // Don't offer a link that goes nowhere: to the page you are already on, or
  // to wherever the very next crumb goes anyway (the org crumb and
  // "All projects" both point at `/projects`). Those crumbs stay as text.
  const renderedCrumbs = crumbs.map((crumb, i) => ({
    ...crumb,
    href:
      crumb.href === pathname || crumb.href === crumbs[i + 1]?.href
        ? undefined
        : crumb.href,
  }));

  return (
    <div className="flex w-full items-center gap-2 px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4!" />
      <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
        <BreadcrumbList className="flex-nowrap overflow-hidden">
          {renderedCrumbs.map((crumb, i) => {
            const isLast = i === renderedCrumbs.length - 1;
            return (
              <span key={`${i}:${crumb.label}`} className="contents">
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {isLast ? (
                    // `aria-current="page"` — only ever the leaf.
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  ) : crumb.href ? (
                    <BreadcrumbLink asChild>
                      <Link href={crumb.href}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    // A crumb with nowhere to go (`Settings`, or an ancestor
                    // whose destination the next crumb repeats). Wrapped so it
                    // is not an anchor and keeps the default cursor — the
                    // affordance links get from `<a href>`. Deliberately NOT
                    // dimmed: `--muted-foreground` is already at the AA
                    // contrast floor, so fading it would trade one honesty
                    // problem for a legibility one.
                    <span className="cursor-default">{crumb.label}</span>
                  )}
                </BreadcrumbItem>
              </span>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-8 md:inline-flex"
              asChild
            >
              <a
                href="https://onecli.sh/docs"
                target="_blank"
                rel="noopener noreferrer"
              >
                <BookOpen className="size-4" />
                <span className="sr-only">Documentation</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Docs</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-8 md:inline-flex"
              asChild
            >
              <a
                href="https://github.com/onecli/onecli"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitHubIcon className="size-4" />
                <span className="sr-only">GitHub</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>GitHub</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-8 md:inline-flex"
              asChild
            >
              <a
                href="https://discord.gg/PSztzsQB3g"
                target="_blank"
                rel="noopener noreferrer"
              >
                <DiscordIcon className="size-4" />
                <span className="sr-only">Discord</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Discord</TooltipContent>
        </Tooltip>
        {/* This header ships only in flat single-project editions (the
            org-scoped editions alias it away), where the bell is always
            live — it self-guards for any other context. */}
        <Separator
          orientation="vertical"
          className="mx-1 hidden h-4! md:block"
        />
        <ApprovalsBell />
        <Separator
          orientation="vertical"
          className="mx-1 hidden h-4! md:block"
        />
        <GetStartedButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">Toggle theme</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle theme</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};

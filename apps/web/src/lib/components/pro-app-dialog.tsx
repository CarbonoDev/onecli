"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";
import { UnavailableBadge } from "@/lib/components/unavailable-badge";

interface ProAppDialogProps {
  appName: string;
  appIcon: string;
  appDarkIcon?: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Shown when the user opens something this build does not implement: an
 * `available: false` registry app (Connections list) or a capability without an
 * OSS implementation (granular access). Informational only — the dialog's close
 * button is the only action. Every EE edition aliases this module away
 * (`next.config.js` → `@/ee/apps/pro-app-dialog`).
 */
export const ProAppDialog = ({
  appName,
  appIcon,
  appDarkIcon,
  description,
  open,
  onOpenChange,
}: ProAppDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-sm">
        <div className="flex flex-col items-center px-8 pt-10 pb-8">
          <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <AppIcon
              icon={appIcon}
              darkIcon={appDarkIcon}
              name={appName}
              size={28}
            />
          </div>

          <DialogHeader className="mt-4 items-center p-0">
            <DialogTitle className="text-lg">{appName}</DialogTitle>
          </DialogHeader>

          <div className="mt-2">
            <UnavailableBadge />
          </div>

          <p className="mt-4 text-center text-sm leading-relaxed text-muted-foreground text-balance">
            {description}
          </p>
          <p className="mt-1.5 text-center text-xs text-muted-foreground/70 text-balance">
            Not yet available in this build.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};

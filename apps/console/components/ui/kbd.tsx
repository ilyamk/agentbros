/** Keyboard key hint (shadcn/ui Kbd, MIT). */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-sm border bg-muted px-1 font-mono text-xs font-medium text-muted-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}

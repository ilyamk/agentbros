/** shadcn/ui Skeleton (MIT): a static block (no pulse animation, RFC 0004 §10.1 transitions only). */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" aria-hidden="true" className={cn("rounded-md bg-muted", className)} {...props} />;
}

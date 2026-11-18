/**
 * shadcn/ui charts (MIT) on Recharts, CSP-safe: shadcn's `ChartStyle` injects a <style> element, which the console's
 * policy forbids, so the series colours are set as CSS variables through the `style` prop (CSSOM) instead.
 */
import type { CSSProperties, ComponentProps, ReactNode } from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

export type ChartConfig = Record<string, { label: string; color: string }>;

export function ChartContainer({
  config,
  className,
  children,
  label,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { config: ChartConfig; children: ReactNode; label: string }) {
  const style = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [`--color-${key}`, value.color]),
  ) as CSSProperties;
  return (
    <div
      data-slot="chart"
      role="img"
      aria-label={label}
      className={cn(
        "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/60 [&_.recharts-surface]:outline-hidden",
        className,
      )}
      style={style}
      {...props}
    >
      <ResponsiveContainer>{children as never}</ResponsiveContainer>
    </div>
  );
}

/** Legend rendered by the console (Recharts' default legend is replaced so its text uses the tokens). */
export function ChartLegend({ config }: { config: ChartConfig }) {
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {Object.entries(config).map(([key, value]) => (
        <li key={key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-[2px]" style={{ background: value.color }} />
          {value.label}
        </li>
      ))}
    </ul>
  );
}

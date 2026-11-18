/**
 * shadcn/ui Slider (MIT) on the console tokens, single thumb: the console's only visible range control (no native
 * `type="range"`, whose track the browser draws outside the theme). Accessible name, value text and data attributes go
 * on the thumb (`role="slider"`), which is the element that takes focus.
 */
import type { ComponentProps } from "react";
import { Slider as SliderPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

type ThumbProps = Omit<ComponentProps<typeof SliderPrimitive.Thumb>, "children"> & Record<`data-${string}`, unknown>;

export function Slider({
  className,
  value,
  onValueChange,
  thumb,
  ...props
}: Omit<ComponentProps<typeof SliderPrimitive.Root>, "value" | "defaultValue" | "onValueChange"> & {
  value: number;
  onValueChange: (value: number) => void;
  thumb?: ThumbProps;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={[value]}
      onValueChange={(values) => onValueChange(values[0]!)}
      className={cn(
        "relative flex h-6 w-full touch-none items-center select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        {...thumb}
        className={cn(
          "block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm transition-[box-shadow] duration-150 hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:pointer-events-none",
          thumb?.className,
        )}
      />
    </SliderPrimitive.Root>
  );
}

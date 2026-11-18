/**
 * shadcn/ui Select (MIT) on the console tokens, and `SelectField`, the one dropdown every form uses: the console has no
 * native `<select>`, whose option list the operating system draws outside the theme. The viewport's injected <style>
 * carries the CSP nonce.
 */
import type { ComponentProps, ReactNode } from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { cspNonce } from "@/lib/nonce";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  size = "default",
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "default" | "sm" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit min-w-40 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm whitespace-nowrap shadow-xs outline-none transition-[color,box-shadow,border-color] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[placeholder]:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 dark:bg-input/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&>span]:min-w-0 [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        collisionPadding={8}
        className={cn(
          "relative z-50 max-h-[min(var(--radix-select-content-available-height),24rem)] max-w-[calc(100vw-1rem)] min-w-[max(8rem,var(--radix-select-trigger-width))] overflow-x-hidden overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md transition-opacity duration-150 starting:opacity-0",
          position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport
          nonce={cspNonce()}
          className={cn("p-1", position === "popper" && "h-[var(--radix-select-trigger-height)] w-full scroll-my-1")}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 ps-2 pe-8 text-sm outline-hidden select-none wrap-anywhere focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[state=checked]:font-medium",
        className,
      )}
      {...props}
    >
      <span className="absolute end-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  lang?: string;
}

/** Radix reserves the empty value for "no selection"; an option whose value is `""` travels as this sentinel. */
const EMPTY = "__select-field-empty__";
const encode = (value: string) => (value === "" ? EMPTY : value);
const decode = (value: string) => (value === EMPTY ? "" : value);

export interface SelectFieldProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  size?: "default" | "sm";
  className?: string;
  contentClassName?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "data-testid"?: string;
  /** Extra data attributes on the trigger (`data-axis`, …). */
  data?: Record<`data-${string}`, string | number | undefined>;
}

/**
 * A labelled dropdown that fills its column (`w-full min-w-0`, truncating the chosen label). The trigger keeps the
 * control's `id`, so `<Label htmlFor>` and review:ui's element ids still point at it; `data-value` mirrors the value.
 */
export function SelectField({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  size,
  className,
  contentClassName,
  data,
  ...aria
}: SelectFieldProps) {
  const known = options.some((option) => option.value === value);
  return (
    <Select
      value={known ? encode(value) : ""}
      onValueChange={(next) => onValueChange(decode(next))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        size={size}
        data-value={value}
        className={cn("w-full min-w-0", className)}
        {...aria}
        {...data}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={encode(option.value)}
            data-value={option.value}
            disabled={option.disabled}
            lang={option.lang}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

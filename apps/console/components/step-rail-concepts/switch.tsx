/**
 * Temporary concept preview for the step rail (docs/console-steps.md): renders today's rail or concept A, B or C (or
 * all four) against this project's view, every status at once, or a scripted run. The choice lives in the query string
 * (`?rail=current|a|b|c|all&railData=live|every|simulate`), so a link reproduces it. Removed once the user picks.
 */
import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { ProjectView } from "@contract";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StepRail } from "@/components/step-rail";
import { railInput, type ConceptProps, type RailInput } from "./model";
import { ConceptA } from "./concept-a";
import { ConceptB } from "./concept-b";
import { ConceptC } from "./concept-c";
import { everyStatusInput, simulatedInput } from "./demo";

export const CONCEPTS = ["current", "a", "b", "c", "all"] as const;
export type Concept = (typeof CONCEPTS)[number];
export const DATA_SOURCES = ["live", "every", "simulate"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

const SIMULATION_MS = 1800;

function readParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const value = new URLSearchParams(window.location.search).get(name);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function writeParam(name: string, value: string, fallback: string): void {
  const url = new URL(window.location.href);
  if (value === fallback) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(window.history.state, "", url);
}

function CurrentRail({ input, selected, onSelect, label, className }: ConceptProps) {
  return (
    <StepRail
      steps={input.steps}
      current={input.current}
      selected={selected}
      onSelect={onSelect}
      label={label}
      className={className}
    />
  );
}

export const CONCEPT_COMPONENTS = { current: CurrentRail, a: ConceptA, b: ConceptB, c: ConceptC } as const;

function Segmented<T extends string>({
  label,
  options,
  value,
  names,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  names: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          data-option={option}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            value === option && "bg-background text-foreground shadow-sm dark:bg-input/30",
          )}
        >
          {names[option]}
        </button>
      ))}
    </div>
  );
}

export interface StepRailSwitchProps {
  view: ProjectView;
  selected?: string;
  onSelect?: (id: string) => void;
  label: string;
}

export function StepRailSwitch({ view, selected, onSelect, label }: StepRailSwitchProps) {
  const { d } = useI18n();
  const [concept, setConcept] = useState<Concept>(() => readParam("rail", CONCEPTS, "current"));
  const [data, setData] = useState<DataSource>(() => readParam("railData", DATA_SOURCES, "live"));
  const [tick, setTick] = useState(0);
  const [demoSelected, setDemoSelected] = useState<string | undefined>();

  useEffect(() => {
    if (data !== "simulate") return;
    const timer = window.setInterval(() => setTick((value) => value + 1), SIMULATION_MS);
    return () => window.clearInterval(timer);
  }, [data]);

  const input: RailInput =
    data === "every" ? everyStatusInput() : data === "simulate" ? simulatedInput(tick) : railInput(view);
  const live = data === "live";
  const pick = live ? selected : demoSelected;
  const onPick = live ? onSelect : setDemoSelected;

  const chooseConcept = (value: Concept) => {
    setConcept(value);
    writeParam("rail", value, "current");
  };
  const chooseData = (value: DataSource) => {
    setData(value);
    setTick(0);
    setDemoSelected(undefined);
    writeParam("railData", value, "live");
  };

  const shown = concept === "all" ? (["current", "a", "b", "c"] as const) : [concept];

  return (
    <TooltipProvider>
      <div data-rail-concept={concept} data-rail-data={data} className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-dashed px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">{d.stepRail.switcher}</span>
          <Segmented
            label={d.stepRail.switcher}
            options={CONCEPTS}
            value={concept}
            names={d.stepRail.concepts}
            onChange={chooseConcept}
          />
          <Segmented
            label={d.stepRail.data}
            options={DATA_SOURCES}
            value={data}
            names={d.stepRail.dataSources}
            onChange={chooseData}
          />
          {data === "simulate" ? (
            <Button variant="ghost" size="sm" onClick={() => setTick(0)}>
              <RotateCcw aria-hidden="true" />
              {d.stepRail.restart}
            </Button>
          ) : null}
        </div>
        {shown.map((key) => {
          const Component = CONCEPT_COMPONENTS[key];
          return (
            <div key={key} data-rail-preview={key} className="flex min-w-0 flex-col gap-2">
              {concept === "all" || key !== "current" ? (
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-semibold tracking-wide uppercase">{d.stepRail.concepts[key]}</span>
                  <span className="text-xs text-muted-foreground">{d.stepRail.conceptHints[key]}</span>
                </div>
              ) : null}
              <Component
                input={input}
                selected={pick ?? input.current}
                onSelect={onPick}
                label={concept === "all" ? `${label} (${d.stepRail.concepts[key]})` : label}
              />
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

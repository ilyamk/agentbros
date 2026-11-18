/** Agents: the active run and today's runs grouped per step, as tool-call cards (RFC 0004 US8). */
import type { AgentRun } from "@contract";
import { Bot, Clapperboard, Code, Palette, PenLine, Search, Sparkles, Volume2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { useNow } from "@/lib/clock";
import { formatDuration, formatTime } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { ThinkingLoader } from "@/components/thinking-loader";
import { ToolCallCard, ToolCallGroup, type ToolCallStatus } from "@/components/tool-call";
import type { PanelProps } from "../registry";

const STATUS: Record<AgentRun["status"], ToolCallStatus> = {
  running: "running",
  done: "success",
  failed: "error",
  interrupted: "error",
};

function agentIcon(name: string) {
  if (/critic|review/.test(name)) return <Search />;
  if (/design|look/.test(name)) return <Palette />;
  if (/motion|engineer|fixer/.test(name)) return <Code />;
  if (/script|writer|copy/.test(name)) return <PenLine />;
  if (/sound|narrator|voice/.test(name)) return <Volume2 />;
  if (/director|strategist|concept/.test(name)) return <Clapperboard />;
  if (/scout|planner/.test(name)) return <Sparkles />;
  return <Bot />;
}

export function runDuration(run: AgentRun, now: number): number {
  if (run.durationMs !== undefined) return run.durationMs;
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return Math.max(0, end - Date.parse(run.startedAt));
}

export function AgentsPanel({ view }: PanelProps) {
  const { d, f, p, locale } = useI18n();
  const now = useNow();
  const active = view.agents.active;
  const groups = new Map<string, AgentRun[]>();
  for (const run of view.agents.today) {
    const key = run.step ?? "";
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const titleOf = (step: string) => {
    if (!step) return d.agents.noStep;
    return view.steps.find((row) => row.id === step)?.title ?? f(d.agents.stepGroup, { step });
  };
  return (
    <div className="flex flex-col gap-3">
      {active ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{d.agents.active}</p>
          <ThinkingLoader
            label={`${active.name}${active.step ? ` · ${titleOf(active.step)}` : ""}${active.lastAlias ? ` · ${active.lastAlias}` : ""}`}
            elapsed={formatDuration(runDuration(active, now), d.units)}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{d.agents.idle}</p>
      )}
      <h3 className="text-sm font-medium">{d.agents.today}</h3>
      {view.agents.today.length === 0 ? (
        <EmptyState compact icon={<Bot />} title={d.agents.noRuns} />
      ) : (
        [...groups.entries()].map(([step, runs]) => {
          const total = runs.reduce((sum, run) => sum + runDuration(run, now), 0);
          const statuses = runs.map((run) => STATUS[run.status]);
          const failed = runs.filter((run) => run.status === "failed" || run.status === "interrupted").length;
          return (
            <ToolCallGroup
              key={step || "none"}
              title={titleOf(step)}
              summary={f(d.agents.group, { runs: p(d.agents.runs, runs.length), time: formatDuration(total, d.units) })}
              statuses={statuses}
              failedLabel={failed ? d.agents.status.failed : undefined}
              icons={runs.map((run) => agentIcon(run.name))}
              defaultOpen={step === view.current?.step}
            >
              {runs.map((run) => (
                <ToolCallCard
                  key={run.id}
                  name={run.name}
                  icon={agentIcon(run.name)}
                  status={STATUS[run.status]}
                  statusLabel={
                    run.status === "failed" || run.status === "interrupted"
                      ? d.agents.status[run.status]
                      : formatDuration(runDuration(run, now), d.units)
                  }
                  summary={[
                    run.role,
                    run.commands !== undefined ? p(d.agents.commands, run.commands) : undefined,
                    run.lastAlias ? f(d.agents.last, { alias: run.lastAlias }) : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  details={[
                    { label: d.agents.started, value: formatTime(run.startedAt, locale) },
                    ...(run.endedAt ? [{ label: d.agents.ended, value: formatTime(run.endedAt, locale) }] : []),
                    ...(run.harness ? [{ label: d.agents.harness, value: run.harness }] : []),
                    ...(run.role ? [{ label: d.agents.role, value: run.role }] : []),
                    ...(run.lane ? [{ label: d.agents.lane, value: run.lane }] : []),
                    { label: d.agents.details, value: d.agents.source[run.source] },
                  ]}
                />
              ))}
            </ToolCallGroup>
          );
        })
      )}
    </div>
  );
}

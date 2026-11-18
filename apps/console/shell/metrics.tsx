/**
 * Metrics (RFC 0004 §12, A19, D20; WP12): decisions and time to decision, rework, refusals, spend per month with the
 * unknown-priced items beside every sum, agent activity, final verdicts and a row per project. Read from
 * `GET /api/metrics` (derived locally from the journals and ledgers); refreshed when the home page's data changes.
 */
import { useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, Clock, Coins, Gavel, RefreshCw, Repeat, Star } from "lucide-react";
import type { ConsoleMetrics } from "../../../src/lib/console/metrics-schema";
import { useI18n } from "@/i18n";
import { asFailure, type ApiFailure } from "@/api/errors";
import { formatDuration, formatNumber, formatUsd } from "@/lib/format";
import { useConsole, useConsoleStore } from "@/store/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { MetricCard } from "@/components/metric-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type State =
  { status: "loading" } | { status: "ready"; metrics: ConsoleMetrics } | { status: "error"; error: ApiFailure };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function MetricsPage() {
  const { d, f, p, locale } = useI18n();
  const store = useConsoleStore();
  const home = useConsole((s) => s.home.data);
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(
    (signal?: AbortSignal) => {
      const client = store.client;
      if (!client.metrics) {
        setState({ status: "error", error: asFailure(new Error(d.metrics.unavailableHint)) });
        return;
      }
      client.metrics(signal).then(
        (metrics) => setState({ status: "ready", metrics }),
        (error: unknown) => {
          if (!signal?.aborted) setState({ status: "error", error: asFailure(error) });
        },
      );
    },
    [store, d],
  );

  useEffect(() => {
    store.watch(undefined);
  }, [store]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, home]);

  const time = (ms: number | undefined) => (ms === undefined ? d.metrics.none : formatDuration(ms, d.units));
  const usd = (value: number) => formatUsd(value, locale);
  const pct = (value: number | undefined) =>
    value === undefined ? d.metrics.none : `${formatNumber(value * 100, locale)}%`;

  let body: React.ReactNode;
  if (state.status === "loading")
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {d.metrics.loading}
      </p>
    );
  else if (state.status === "error")
    body = (
      <EmptyState
        title={d.metrics.unavailable}
        description={state.error.message}
        action={
          <Button variant="outline" onClick={() => load()}>
            {d.app.retry}
          </Button>
        }
      />
    );
  else {
    const m = state.metrics;
    const decisions = m.decisions;
    body = (
      <>
        {m.truncated ? (
          <p role="note" className="text-sm text-status-stale">
            {d.metrics.truncated}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<Gavel aria-hidden="true" />}
            label={d.metrics.decided}
            value={formatNumber(decisions.decided, locale)}
            context={`${d.metrics.consoleShare}: ${pct(decisions.consoleShare)} · ${d.metrics.refused}: ${decisions.refused}`}
          />
          <MetricCard
            icon={<Clock aria-hidden="true" />}
            label={d.metrics.timeToDecision}
            value={time(decisions.timeToDecision.medianMs)}
            context={f(d.metrics.p90, { time: time(decisions.timeToDecision.p90Ms) })}
          />
          <MetricCard
            icon={<Activity aria-hidden="true" />}
            label={d.metrics.waitingNow}
            value={formatNumber(decisions.waiting.count, locale)}
            tone={decisions.waiting.count ? "waiting" : undefined}
            context={
              decisions.waiting.oldestMs !== undefined
                ? f(d.metrics.oldest, { time: time(decisions.waiting.oldestMs) })
                : undefined
            }
          />
          <MetricCard
            icon={<Repeat aria-hidden="true" />}
            label={d.metrics.reworkRate}
            value={pct(m.rework.rate)}
            context={`${p(d.metrics.reopened, m.rework.reopened)} ${p(d.metrics.gates, m.rework.gates)}`}
          />
        </div>

        <Section title={d.metrics.spend}>
          <div className="grid gap-3 sm:grid-cols-2">
            <MetricCard
              icon={<Coins aria-hidden="true" />}
              label={d.metrics.spent}
              value={
                m.spend.unreadable ? `${usd(m.spend.spentUsd)} + ${d.metrics.unknownValue}` : usd(m.spend.spentUsd)
              }
              tone={m.spend.unreadable ? "stale" : undefined}
              context={
                m.spend.unreadable
                  ? p(d.metrics.unreadable, m.spend.unreadable)
                  : `${d.metrics.reserved}: ${usd(m.spend.reservedUsd)}`
              }
            />
            {m.spend.unknownPriced ? (
              <MetricCard
                icon={<Coins aria-hidden="true" />}
                label={p(d.metrics.unknownPriced, m.spend.unknownPriced)}
                value={String(m.spend.unknownPriced)}
                tone="stale"
                context={d.metrics.unknownHint}
              />
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{d.metrics.month}</TableHead>
                  <TableHead className="text-end">{d.metrics.spent}</TableHead>
                  <TableHead className="text-end">{d.metrics.unknownColumn}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.spend.months.map((month) => (
                  <TableRow key={month.month}>
                    <TableCell className="font-mono">{month.month}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {month.unreadable ? `${usd(month.spentUsd)} + ${d.metrics.unknownValue}` : usd(month.spentUsd)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {month.unknownPriced ? p(d.metrics.unknownPriced, month.unknownPriced) : d.metrics.none}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>

        <Section title={d.metrics.steps}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{d.metrics.step}</TableHead>
                  <TableHead className="text-end">{d.metrics.decided}</TableHead>
                  <TableHead className="text-end">{d.metrics.rounds}</TableHead>
                  <TableHead className="text-end">{d.metrics.refused}</TableHead>
                  <TableHead className="text-end">{d.metrics.timeToDecision}</TableHead>
                  <TableHead className="text-end">{d.metrics.agentTime}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.steps.map((step) => (
                  <TableRow key={step.step}>
                    <TableCell className="font-mono">{step.step}</TableCell>
                    <TableCell className="text-end tabular-nums">{step.decided}</TableCell>
                    <TableCell className="text-end tabular-nums">{step.rounds}</TableCell>
                    <TableCell className="text-end tabular-nums">{step.refused}</TableCell>
                    <TableCell className="text-end tabular-nums">{time(step.timeToDecision.medianMs)}</TableCell>
                    <TableCell className="text-end tabular-nums">{time(step.agentMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title={d.metrics.refusals}>
            {m.refusals.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {m.refusals.map((refusal) => (
                  <li key={refusal.code} className="flex justify-between gap-2 rounded-md bg-muted/60 px-2 py-1">
                    <code className="font-mono text-xs">{refusal.code}</code>
                    <span className="tabular-nums">{refusal.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{d.metrics.noRefusals}</p>
            )}
          </Section>
          <Section title={d.metrics.agents}>
            <p className="text-sm text-muted-foreground">
              {p(d.metrics.runs, m.agents.runs)} · {time(m.agents.totalMs)}
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {m.agents.byAgent.map((agent) => (
                <li key={agent.name} className="flex justify-between gap-2 rounded-md bg-muted/60 px-2 py-1">
                  <span className="min-w-0 truncate">{agent.name}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {p(d.metrics.runs, agent.runs)} · {time(agent.totalMs)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <Section title={d.metrics.verdicts}>
          <p className="flex items-center gap-2 text-sm">
            <Star aria-hidden="true" className="size-4 text-muted-foreground" />
            {f(d.metrics.verdictCapture, { with: m.verdicts.withVerdict, delivered: m.verdicts.delivered })}
          </p>
          {m.verdicts.byPlaybook.length ? (
            <ul className="flex flex-col gap-1 text-sm">
              {m.verdicts.byPlaybook.map((row) => (
                <li key={row.playbook} className="flex justify-between gap-2 rounded-md bg-muted/60 px-2 py-1">
                  <span>{row.playbook}</span>
                  <span className="tabular-nums">
                    {d.metrics.meanScore}: {formatNumber(row.meanScore, locale, 1)} · {row.count}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section title={d.metrics.projects}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{d.metrics.project}</TableHead>
                  <TableHead className="text-end">{d.metrics.decided}</TableHead>
                  <TableHead className="text-end">{d.metrics.waiting}</TableHead>
                  <TableHead className="text-end">{d.metrics.refused}</TableHead>
                  <TableHead className="text-end">{d.metrics.spent}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.projects.map((row) => (
                  <TableRow key={row.project}>
                    <TableCell>
                      <a className="underline-offset-4 hover:underline" href={`#/projects/${row.project}`}>
                        {row.project}
                      </a>
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{row.decided}</TableCell>
                    <TableCell className="text-end tabular-nums">{row.waiting}</TableCell>
                    <TableCell className="text-end tabular-nums">{row.refused}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {row.spendUnreadable ? d.metrics.unknownValue : usd(row.spentUsd)}
                      {row.unknownPriced ? ` + ${p(d.metrics.unknownPriced, row.unknownPriced)}` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      </>
    );
  }

  return (
    <main id="main" tabIndex={-1} className="outline-none flex min-w-0 flex-col gap-6 p-4 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
            <BarChart3 aria-hidden="true" className="size-6 text-muted-foreground" />
            {d.metrics.title}
          </h1>
          <p className="text-sm text-muted-foreground">{d.metrics.subtitle}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()}>
          <RefreshCw aria-hidden="true" />
          {d.metrics.refresh}
        </Button>
      </header>
      <div aria-live="polite" className="flex min-w-0 flex-col gap-6">
        {body}
      </div>
    </main>
  );
}

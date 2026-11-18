/**
 * Money (RFC 0004 US5, FR4): metric cards, the budget meter, spend per provider (shadcn charts on Recharts) and the
 * paid jobs table (TanStack Table v9). Unknown prices are counted and labelled, never shown as free.
 */
import { useMemo, useState } from "react";
import type { JobSummary, ProjectView } from "@contract";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, CircleDollarSign, CircleHelp, Landmark, Lock } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useI18n, type Dictionary } from "@/i18n";
import { formatTime, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MetricCard } from "@/components/metric-card";
import { UsageMeter } from "@/components/usage-meter";
import { EmptyState } from "@/components/empty-state";
import { ToneBadge } from "@/components/status";
import { ChartContainer, ChartLegend, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Tone } from "@/lib/status";
import type { PanelProps } from "../registry";

const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel(), sortFns });
const helper = createColumnHelper<typeof features, JobSummary>();

const JOB_TONE: Record<JobSummary["state"], Tone> = {
  planned: "upcoming",
  reserved: "paused",
  submitting: "current",
  queued: "current",
  running: "current",
  "result-ready": "current",
  downloading: "current",
  validated: "done",
  published: "done",
  failed: "blocked",
  cancelled: "skipped",
  unknown: "stale",
};

export function ceilingOf(view: ProjectView): number | undefined {
  return view.money.ceilingUsd ?? view.autonomy.ceilingUsd;
}

function useColumns(d: Dictionary, locale: string) {
  return useMemo(
    () =>
      helper.columns([
        helper.accessor("id", {
          header: d.money.columns.job,
          cell: (info) => <code className="font-mono text-xs">{info.getValue()}</code>,
        }),
        helper.accessor((job) => `${job.provider}${job.endpoint ? ` · ${job.endpoint}` : ""}`, {
          id: "provider",
          header: d.money.columns.provider,
          cell: (info) => <span className="break-all">{info.getValue()}</span>,
        }),
        helper.accessor((job) => job.step ?? "", { id: "step", header: d.money.columns.step }),
        helper.accessor("state", {
          header: d.money.columns.state,
          cell: (info) => <ToneBadge tone={JOB_TONE[info.getValue()]}>{info.getValue()}</ToneBadge>,
        }),
        helper.accessor((job) => job.costUsd ?? job.reservedUsd ?? -1, {
          id: "cost",
          header: d.money.columns.cost,
          cell: (info) => {
            const job = info.row.original;
            if (!job.priceKnown && job.costUsd === undefined)
              return (
                <span className="inline-flex items-center gap-1 text-status-waiting">
                  <CircleHelp className="size-3.5" aria-hidden="true" />
                  <span className="text-foreground">{d.money.priceUnknown}</span>
                </span>
              );
            if (job.costUsd !== undefined)
              return <span className="tabular-nums">{formatUsd(job.costUsd, locale)}</span>;
            if (job.reservedUsd !== undefined)
              return (
                <span className="text-muted-foreground tabular-nums">
                  {d.money.reservedShort.replace("{amount}", formatUsd(job.reservedUsd, locale))}
                </span>
              );
            return null;
          },
        }),
        helper.accessor((job) => job.submittedAt ?? "", {
          id: "submitted",
          header: d.money.columns.submitted,
          cell: (info) => (info.getValue() ? formatTime(info.getValue(), locale) : ""),
        }),
      ]),
    [d, locale],
  );
}

function JobsTable({ jobs }: { jobs: JobSummary[] }) {
  const { d, f, locale } = useI18n();
  const columns = useColumns(d, locale);
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useTable({ features, columns, data: jobs, state: { sorting }, onSortingChange: setSorting });
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              const label = String(header.column.columnDef.header ?? header.id);
              return (
                <TableHead
                  key={header.id}
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                >
                  <button
                    type="button"
                    onClick={header.column.getToggleSortingHandler()}
                    aria-label={f(d.money.sortBy, { column: label })}
                    className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {label}
                    {sorted === "asc" ? (
                      <ArrowUp className="size-3" aria-hidden="true" />
                    ) : sorted === "desc" ? (
                      <ArrowDown className="size-3" aria-hidden="true" />
                    ) : (
                      <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />
                    )}
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getAllCells().map((cell) => (
              <TableCell key={cell.id}>
                <table.FlexRender cell={cell} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SpendChart({ view }: { view: ProjectView }) {
  const { d, locale } = useI18n();
  const config: ChartConfig = {
    spent: { label: d.money.spent, color: "var(--chart-1)" },
    reserved: { label: d.money.reserved, color: "var(--chart-3)" },
  };
  const data = view.money.byProvider.map((row) => ({
    provider: row.provider,
    spent: row.spentUsd,
    reserved: row.reservedUsd,
  }));
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium">{d.money.byProvider}</figcaption>
      <ChartContainer config={config} label={d.money.chartLabel} className="aspect-auto h-48 w-full">
        <BarChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="provider" tickLine={false} axisLine={false} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(value: number) => formatUsd(value, locale)}
          />
          <Bar
            dataKey="spent"
            stackId="usd"
            fill="var(--color-spent)"
            radius={[0, 0, 3, 3]}
            isAnimationActive={false}
          />
          <Bar
            dataKey="reserved"
            stackId="usd"
            fill="var(--color-reserved)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <ChartLegend config={config} />
    </figure>
  );
}

export function MoneyPanel({ view }: PanelProps) {
  const { d, f, locale } = useI18n();
  const money = view.money;
  const ceiling = ceilingOf(view);
  const usd = (value: number) => formatUsd(value, locale);
  const over = ceiling !== undefined && money.spentUsd + money.reservedUsd > ceiling;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
        <MetricCard
          icon={<CircleDollarSign />}
          label={d.money.spent}
          value={usd(money.spentUsd)}
          context={d.money.spentContext}
        />
        <MetricCard
          icon={<Lock />}
          label={d.money.reserved}
          value={usd(money.reservedUsd)}
          context={d.money.reservedContext}
        />
        <MetricCard
          icon={<Landmark />}
          label={d.money.ceiling}
          value={ceiling !== undefined ? usd(ceiling) : d.money.noCeiling}
          tone={over ? "blocked" : undefined}
          context={
            ceiling !== undefined
              ? f(d.money.ceilingContext, { amount: usd(Math.max(0, ceiling - money.spentUsd - money.reservedUsd)) })
              : d.money.noCeilingContext
          }
        />
        <MetricCard
          icon={<CircleHelp />}
          label={d.money.unknownPriced}
          value={String(money.unknownPriced)}
          tone={money.unknownPriced ? "waiting" : undefined}
          context={d.money.unknownPricedContext}
        />
      </div>
      <UsageMeter
        label={d.money.budget}
        limit={ceiling}
        format={usd}
        freeLabel={d.money.left}
        overLabel={d.money.over}
        nearLabel={d.money.near}
        segments={[
          { id: "spent", label: d.money.spent, value: money.spentUsd, color: "var(--chart-1)" },
          { id: "reserved", label: d.money.reserved, value: money.reservedUsd, color: "var(--chart-3)" },
        ]}
      />
      <div className={cn("grid gap-4", money.byProvider.length ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : "")}>
        {money.byProvider.length ? <SpendChart view={view} /> : null}
        <section aria-label={d.money.jobs} className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium">{d.money.jobs}</h3>
          {money.jobs.length ? <JobsTable jobs={money.jobs} /> : <EmptyState compact title={d.money.noJobs} />}
        </section>
      </div>
    </div>
  );
}

/** Assets (RFC 0004 US12): provenance, licence, cost and where each is used; table or grid (skeleton for WP10). */
import { useState } from "react";
import type { AssetSummary, MediaRef } from "@contract";
import { Grid3x3, Package, Rows3 } from "lucide-react";
import { useI18n } from "@/i18n";
import { formatUsd } from "@/lib/format";
import { MediaSlot } from "@/media";
import { EmptyState } from "@/components/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PanelProps } from "../registry";

const MEDIA_KIND: Partial<Record<AssetSummary["kind"], MediaRef["kind"]>> = {
  image: "image",
  video: "video",
  audio: "audio",
};

function thumbnailOf(asset: AssetSummary): MediaRef {
  return (
    asset.thumbnail ?? {
      path: asset.path,
      kind: MEDIA_KIND[asset.kind] ?? "document",
      label: asset.path.split("/").at(-1),
    }
  );
}

export function AssetsPanel({ view }: PanelProps) {
  const { d, locale } = useI18n();
  const [mode, setMode] = useState("table");
  if (!view.assets.length)
    return <EmptyState compact icon={<Package />} title={d.assets.empty} description={d.assets.emptyHint} />;
  return (
    <Tabs value={mode} onValueChange={setMode}>
      <TabsList aria-label={d.assets.title}>
        <TabsTrigger value="table">
          <Rows3 aria-hidden="true" />
          {d.assets.table}
        </TabsTrigger>
        <TabsTrigger value="grid">
          <Grid3x3 aria-hidden="true" />
          {d.assets.grid}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{d.assets.columns.asset}</TableHead>
              <TableHead>{d.assets.columns.kind}</TableHead>
              <TableHead>{d.assets.columns.origin}</TableHead>
              <TableHead>{d.assets.columns.licence}</TableHead>
              <TableHead>{d.assets.columns.cost}</TableHead>
              <TableHead>{d.assets.columns.usedIn}</TableHead>
              <TableHead>{d.assets.columns.approved}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.assets.map((asset) => (
              <TableRow key={asset.id}>
                <TableCell>
                  <code className="font-mono text-xs break-all">{asset.path}</code>
                </TableCell>
                <TableCell>{asset.kind}</TableCell>
                <TableCell>{[asset.origin, asset.provider].filter(Boolean).join(" · ")}</TableCell>
                <TableCell>{asset.licence?.id ?? asset.licence?.name ?? ""}</TableCell>
                <TableCell className="tabular-nums">
                  {asset.costUsd !== undefined ? formatUsd(asset.costUsd, locale) : ""}
                </TableCell>
                <TableCell>{asset.usedIn.join(", ")}</TableCell>
                <TableCell>{asset.approved === undefined ? "" : asset.approved ? d.assets.yes : d.assets.no}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TabsContent>
      <TabsContent value="grid">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {view.assets.map((asset) => (
            <li key={asset.id}>
              <MediaSlot project={view.project.id} media={thumbnailOf(asset)} variant="thumb" />
            </li>
          ))}
        </ul>
      </TabsContent>
    </Tabs>
  );
}

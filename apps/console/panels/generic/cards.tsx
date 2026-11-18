/** Agent cards panel: every card on the canvas, open questions first (RFC 0004 D14, US18). */
import { Bot } from "lucide-react";
import { useI18n } from "@/i18n";
import { AgentCard } from "@/components/agent-card";
import { EmptyState } from "@/components/empty-state";
import type { PanelProps } from "../registry";

export function CardsPanel({ view }: PanelProps) {
  const { d } = useI18n();
  if (!view.cards.length)
    return <EmptyState compact icon={<Bot />} title={d.cards.empty} description={d.cards.emptyHint} />;
  const open = (card: (typeof view.cards)[number]) => card.expectsAnswer && !card.answer;
  const cards = [...view.cards].sort(
    (a, b) => Number(open(b)) - Number(open(a)) || b.createdAt.localeCompare(a.createdAt),
  );
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {cards.map((card) => (
        <AgentCard key={card.id} card={card} />
      ))}
    </div>
  );
}

/** The `/` search palette (RFC 0004 FR9): pages, projects and the current project's steps. */
import type { ProjectView } from "@contract";
import { Clapperboard, Home, ListOrdered, Settings } from "lucide-react";
import { useI18n } from "@/i18n";
import { useConsole } from "@/store/context";
import { navigate, projectHref, useRoute } from "@/lib/router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export function SearchPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { d } = useI18n();
  const route = useRoute();
  const projects = useConsole((s) => s.home.data?.projects) ?? [];
  const project = route.name === "project" ? route.project : undefined;
  const view: ProjectView | undefined = useConsole((s) => (project ? s.views[project]?.data : undefined));
  const go = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={d.search.title}
      description={d.search.placeholder}
      label={d.search.title}
    >
      <CommandInput placeholder={d.search.placeholder} />
      <CommandList>
        <CommandEmpty>{d.search.empty}</CommandEmpty>
        <CommandGroup heading={d.search.pages}>
          <CommandItem value={`page ${d.nav.home}`} onSelect={() => go("#/")}>
            <Home aria-hidden="true" />
            {d.nav.home}
          </CommandItem>
          <CommandItem value={`page ${d.nav.settings}`} onSelect={() => go("#/settings")}>
            <Settings aria-hidden="true" />
            {d.nav.settings}
          </CommandItem>
        </CommandGroup>
        {projects.length ? (
          <CommandGroup heading={d.search.projects}>
            {projects.map((item) => (
              <CommandItem
                key={item.id}
                value={`project ${item.id} ${item.title ?? ""}`}
                onSelect={() => go(projectHref(item.id))}
              >
                <Clapperboard aria-hidden="true" />
                {item.title ?? item.id}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {view?.steps.length ? (
          <CommandGroup heading={d.search.steps}>
            {view.steps.map((step) => (
              <CommandItem
                key={step.id}
                value={`step ${step.id} ${step.title}`}
                onSelect={() => go(projectHref(view.project.id))}
              >
                <ListOrdered aria-hidden="true" />
                {step.title}
                <span className="ms-auto text-xs text-muted-foreground">{d.stepStatus[step.status]}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

/**
 * Settings (RFC 0004 §5.1): language, theme, port, hooks status and install (H3), paired browsers, notifications (WP14),
 * about and licence (copyright, version, BUSL-1.1 summary, the "as is" warranty disclaimer, links to the licence files).
 */
import {
  BarChart3,
  Bell,
  Info,
  Keyboard,
  KeyRound,
  Languages,
  MonitorSmartphone,
  Palette,
  Plug,
  Server,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { DEFAULT_CONSOLE_PORT, HOOKS_INSTALL_COMMAND } from "@contract";
import { LANGUAGES, detectLanguage, useI18n, type Language } from "@/i18n";
import { setPreference, usePreferences, type LanguageChoice, type ThemeChoice } from "@/lib/preferences";
import { APP_VERSION, AUTHOR, COPYRIGHT_YEAR, LICENCE_DOCUMENTS, repositoryFile } from "@/lib/about";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CredentialSettings } from "./credentials";
import { HooksSettings } from "./hooks";
import { NotificationSettings } from "./notify";
import { PairedBrowsers } from "./pairings";

function SettingsCard({
  icon,
  title,
  description,
  id,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <Card id={id} className={id === "api-key-settings" ? "scroll-mt-16" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-muted-foreground">
          {icon}
          <h2>{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

const externalLink = "w-fit text-sm font-medium underline underline-offset-4 hover:text-muted-foreground";

/** Copyright, version, licence summary, warranty disclaimer and the licence files on GitHub. */
function AboutSettings() {
  const { d, f } = useI18n();
  const [before, after] = d.about.copyright.split("{author}") as [string, string | undefined];
  return (
    <>
      <p className="text-sm">
        {f(before, { year: COPYRIGHT_YEAR })}
        <a href={AUTHOR.url} target="_blank" rel="noreferrer noopener" className={externalLink}>
          {AUTHOR.name}
          <span className="sr-only"> {d.about.newTab}</span>
        </a>
        {after ? f(after, { year: COPYRIGHT_YEAR }) : null}
      </p>
      <p className="text-sm">
        {d.about.version}: <code className="font-mono">{APP_VERSION}</code>
      </p>
      <p className="text-sm text-muted-foreground">{d.about.licence}</p>
      <section aria-labelledby="about-warranty" className="flex flex-col gap-1">
        <h3 id="about-warranty" className="text-sm font-medium">
          {d.about.warrantyTitle}
        </h3>
        <p className="text-sm text-muted-foreground">{d.about.warranty}</p>
      </section>
      <section aria-labelledby="about-documents" className="flex flex-col gap-1">
        <h3 id="about-documents" className="text-sm font-medium">
          {d.about.documentsTitle}
        </h3>
        <ul className="flex flex-col gap-1">
          {LICENCE_DOCUMENTS.map(([key, file]) => (
            <li key={key}>
              <a href={repositoryFile(file)} target="_blank" rel="noreferrer noopener" className={externalLink}>
                {d.about.documents[key]}
              </a>{" "}
              <code className="font-mono text-xs text-muted-foreground">{file}</code>
              <span className="sr-only"> {d.about.newTab}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function SettingsPage({ focusKeys }: { focusKeys?: boolean } = {}) {
  useEffect(() => {
    if (focusKeys) document.getElementById("api-key-settings")?.scrollIntoView?.({ block: "start" });
  }, [focusKeys]);
  const { d, f } = useI18n();
  const preferences = usePreferences();
  const port = Number(globalThis.location?.port) || DEFAULT_CONSOLE_PORT;
  const system = d.languages[detectLanguage()];
  return (
    <main id="main" tabIndex={-1} className="outline-none flex max-w-3xl min-w-0 flex-col gap-4 p-4 lg:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold">{d.settings.title}</h1>
        <p className="text-sm text-muted-foreground">{d.settings.subtitle}</p>
      </header>

      <SettingsCard icon={<Languages />} title={d.settings.language}>
        <Select
          value={preferences.language}
          onValueChange={(value) => setPreference("language", value as LanguageChoice)}
        >
          <SelectTrigger aria-label={d.settings.language}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{f(d.settings.languageSystem, { language: system })}</SelectItem>
            {LANGUAGES.map((language: Language) => (
              <SelectItem key={language} value={language} lang={language}>
                {d.languages[language]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsCard>

      <SettingsCard icon={<Palette />} title={d.settings.theme}>
        <Select value={preferences.theme} onValueChange={(value) => setPreference("theme", value as ThemeChoice)}>
          <SelectTrigger aria-label={d.settings.theme}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["dark", "light", "system"] as const).map((theme) => (
              <SelectItem key={theme} value={theme}>
                {d.settings.themes[theme]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsCard>

      <SettingsCard icon={<Server />} title={d.settings.server}>
        <p className="text-sm">
          {d.settings.port}: <code className="font-mono">{port}</code>
        </p>
        <p className="text-sm text-muted-foreground">
          {f(d.settings.portHint, { command: "pnpm console --stop && pnpm console --port <N>" })}
        </p>
      </SettingsCard>

      <SettingsCard
        id="api-key-settings"
        icon={<KeyRound />}
        title={d.credentials.title}
        description={d.credentials.description}
      >
        <CredentialSettings />
      </SettingsCard>

      <SettingsCard
        icon={<Plug />}
        title={d.settings.hooks}
        description={f(d.settings.hooksHint, { command: HOOKS_INSTALL_COMMAND })}
      >
        <HooksSettings />
      </SettingsCard>

      <SettingsCard icon={<Bell />} title={d.settings.notifications} description={d.settings.notificationsHint}>
        <NotificationSettings />
      </SettingsCard>

      <SettingsCard icon={<MonitorSmartphone />} title={d.settings.pairedTitle} description={d.settings.pairedHint}>
        <PairedBrowsers />
      </SettingsCard>

      <SettingsCard icon={<BarChart3 />} title={d.metrics.title} description={d.metrics.settingsHint}>
        <a
          href="#/metrics"
          className="w-fit text-sm font-medium underline underline-offset-4 hover:text-muted-foreground"
        >
          {d.metrics.open}
        </a>
      </SettingsCard>

      <SettingsCard icon={<Keyboard />} title={d.settings.keyboard}>
        <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {(
            [
              ["j", d.keyboard.next],
              ["k", d.keyboard.previous],
              ["a", d.keyboard.approve],
              ["r", d.keyboard.reject],
              ["/", d.keyboard.search],
              ["Space", d.keyboard.play],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="contents">
              <dt>
                <Kbd>{key}</Kbd>
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </SettingsCard>

      <SettingsCard id="about" icon={<Info />} title={d.about.title}>
        <AboutSettings />
      </SettingsCard>
    </main>
  );
}

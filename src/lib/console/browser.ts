import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";

const DESKTOP_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
];

/** Opens a console URL through the OS, without passing provider credentials to the launcher. */
export function openConsoleBrowser(
  url: string,
  launch: (command: string, args: string[], options: SpawnOptions) => ChildProcess = spawn,
): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["/usr/bin/open", [url]]
      : process.platform === "win32"
        ? [
            path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
            ["url.dll,FileProtocolHandler", url],
          ]
        : ["/usr/bin/xdg-open", [url]];
  const env = Object.fromEntries(DESKTOP_ENV.map((name) => [name, process.env[name]]));
  if (process.platform !== "win32") env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true, env });
    const finish = (success: boolean) => {
      clearTimeout(deadline);
      if (success) resolve();
      else reject(new Error("Could not open the default browser."));
    };
    // Some desktop launchers stay attached to the browser. Leave that browser running after the request times out.
    const deadline = setTimeout(() => finish(false), 5000);
    child.once("error", () => finish(false));
    child.once("spawn", () => child.unref());
    child.once("exit", (code) => finish(code === 0));
  });
}

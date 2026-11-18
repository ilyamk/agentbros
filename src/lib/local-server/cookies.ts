/** Cookie parsing and the session cookie of loopback servers (`HttpOnly; SameSite=Strict`). */

/** The value of cookie `name` in a `Cookie` header, or '' when absent. */
export function readCookie(header: string | undefined, name: string): string {
  for (const part of String(header ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + "=")) return trimmed.slice(name.length + 1);
  }
  return "";
}

/** `name=value; HttpOnly; SameSite=Strict; Path=<path>`; never `Secure` (plain-http loopback) and never a Domain. */
export function sessionCookie(name: string, value: string, path = "/"): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Unsafe cookie");
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=${path}`;
}

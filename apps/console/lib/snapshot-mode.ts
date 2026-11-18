/**
 * Whether the page is a static snapshot (RFC 0004 WP15, D18), set once at boot. Media viewers read it to show a note
 * instead of a player: a snapshot carries no media and has no server to stream or thumbnail it.
 */
let current: { project: string; takenAt: string } | undefined;

export function setSnapshotMode(value: { project: string; takenAt: string } | undefined): void {
  current = value;
}

export const snapshotMode = () => current;

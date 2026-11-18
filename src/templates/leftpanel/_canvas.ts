import { createContext, useContext } from "react";

/**
 * Project-wide canvas mood for the LEFT panel of a talking-head composition.
 * Set ONCE at the composition root (TalkingHeadScene reads it from
 * `talkingHead.leftPanelCanvas` and provides the value here). Every
 * left-panel kind reads it via `useCanvasMood()` and adapts its background,
 * axis colour and text colour accordingly — no scene-to-scene flicker.
 */
export type CanvasMood = "light" | "dark";

export const CanvasMoodContext = createContext<CanvasMood>("light");

export const useCanvasMood = (): CanvasMood => useContext(CanvasMoodContext);

/** Base background colour for the chosen mood. */
export const canvasBg = (mood: CanvasMood): string => (mood === "dark" ? "#0E1116" : "#F8F8F4");

/** Default text / axis colour for the chosen mood. */
export const canvasFg = (mood: CanvasMood): string => (mood === "dark" ? "#F2F2F0" : "#1A1A1F");

/** Subtle muted tone (axis ticks, secondary lines). */
export const canvasMuted = (mood: CanvasMood): string => (mood === "dark" ? "#7A7A7E" : "#6E6E73");

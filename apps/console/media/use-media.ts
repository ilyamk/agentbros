/**
 * State of a native media element as React state: time, duration, paused, rate, readiness and load errors. While a
 * video plays, the time follows each presented frame (`requestVideoFrameCallback`, else animation frames), so the
 * frame counter does not lag `timeupdate`'s four updates a second. UI code, not Remotion: the determinism law does not
 * apply here.
 */
import { useCallback, useEffect, useState, type RefObject } from "react";

export interface MediaState {
  time: number;
  duration: number;
  paused: boolean;
  rate: number;
  ready: boolean;
  error: boolean;
  videoWidth?: number;
  videoHeight?: number;
}

const INITIAL: MediaState = { time: 0, duration: NaN, paused: true, rate: 1, ready: false, error: false };

interface FrameCallbacks {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export function useMediaState(ref: RefObject<HTMLMediaElement | null>, src: string): MediaState {
  const [state, setState] = useState<MediaState>(INITIAL);

  useEffect(() => {
    setState(INITIAL);
    const element = ref.current;
    if (!element) return;
    const read = () =>
      setState({
        time: element.currentTime,
        duration: element.duration,
        paused: element.paused,
        rate: element.playbackRate,
        ready: element.readyState >= 1,
        error: element.error != null, // jsdom leaves it undefined
        ...(element instanceof HTMLVideoElement
          ? { videoWidth: element.videoWidth || undefined, videoHeight: element.videoHeight || undefined }
          : {}),
      });
    const onError = () => setState((current) => ({ ...current, error: true }));
    const events = ["loadedmetadata", "durationchange", "timeupdate", "seeked", "play", "pause", "ratechange", "ended"];
    for (const name of events) element.addEventListener(name, read);
    element.addEventListener("error", onError);
    // a <source>-less element reports the failure on itself; a 404 before React subscribed shows in `error`
    if (element.error) onError();
    else if (element.readyState >= 1) read();

    let handle = 0;
    let stopped = false;
    const video = element as unknown as FrameCallbacks;
    const frameCallbacks =
      typeof video.requestVideoFrameCallback === "function" && typeof video.cancelVideoFrameCallback === "function";
    const tick = () => {
      if (stopped || element.paused) return;
      setState((current) =>
        current.time === element.currentTime ? current : { ...current, time: element.currentTime },
      );
      handle = frameCallbacks
        ? video.requestVideoFrameCallback!(tick)
        : (globalThis.requestAnimationFrame?.(tick) ?? 0);
    };
    const onPlay = () => {
      stopped = false;
      tick();
    };
    const cancel = () => {
      stopped = true;
      if (frameCallbacks) video.cancelVideoFrameCallback!(handle);
      else globalThis.cancelAnimationFrame?.(handle);
    };
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", cancel);
    return () => {
      cancel();
      for (const name of events) element.removeEventListener(name, read);
      element.removeEventListener("error", onError);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", cancel);
    };
  }, [ref, src]);

  return state;
}

/** Play/pause/seek commands on the element; jsdom and autoplay refusals are swallowed. */
export function useMediaCommands(ref: RefObject<HTMLMediaElement | null>) {
  const toggle = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    if (element.paused) {
      try {
        const result = element.play() as Promise<void> | undefined;
        result?.catch?.(() => {});
      } catch {
        // not implemented (jsdom) or refused
      }
    } else pause(element);
  }, [ref]);
  const seek = useCallback(
    (t: number) => {
      const element = ref.current;
      if (!element) return;
      const duration = Number.isFinite(element.duration) ? element.duration : Infinity;
      element.currentTime = Math.min(Math.max(0, t), duration);
    },
    [ref],
  );
  const setRate = useCallback(
    (rate: number) => {
      if (ref.current) ref.current.playbackRate = rate;
    },
    [ref],
  );
  const stop = useCallback(() => {
    if (ref.current) pause(ref.current);
  }, [ref]);
  return { toggle, seek, setRate, pause: stop };
}

function pause(element: HTMLMediaElement) {
  try {
    element.pause();
  } catch {
    // jsdom
  }
}

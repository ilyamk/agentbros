import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { FrameCommentSchema, type MediaRef } from "@contract";
import { chooseOption, FIXTURE_NOW, fixtureStore, renderWith, selectValue, setSlider } from "@/test/utils";
import { FixtureApiClient } from "@/api/fixture";
import { AudioPlayer, Compare, FrameCommentProvider, MediaSlot, VideoViewer } from "./index";
import { timeOfFrame } from "./frame-math";
import { THUMB_RETRY_MS } from "./retry-img";

const scene: MediaRef = {
  root: "out",
  path: "scenes/scene-3.mp4",
  kind: "video",
  label: "Scene 3",
  renderedAt: "2026-11-17T09:09:00Z",
  sourceHash: "c".repeat(64),
  stale: true,
  durationSec: 4.2,
  width: 1080,
  height: 1920,
  fps: 30,
};

/** jsdom has no media pipeline: give the element a clock and a duration it reports through events. */
function fakeMedia(element: HTMLMediaElement, duration = 4.2) {
  let time = 0;
  let paused = true;
  Object.defineProperty(element, "duration", { configurable: true, get: () => duration });
  Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(element, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(element, "currentTime", {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      element.dispatchEvent(new Event("seeked"));
    },
  });
  element.play = vi.fn(async () => {
    paused = false;
    element.dispatchEvent(new Event("play"));
  });
  element.pause = vi.fn(() => {
    paused = true;
    element.dispatchEvent(new Event("pause"));
  });
  act(() => {
    element.dispatchEvent(new Event("loadedmetadata"));
  });
  return { time: () => time };
}

function videoOf(container: HTMLElement) {
  const video = container.querySelector("video");
  if (!video) throw new Error("no video");
  return video;
}

describe("VideoViewer", () => {
  it("resumes frame updates after a failed source is replaced", () => {
    const { container, rerender } = renderWith(<VideoViewer project="promo-acme" media={scene} />);
    fireEvent.error(videoOf(container));
    rerender(<VideoViewer project="promo-acme" media={{ ...scene, path: "replacement.mp4" }} />);
    const video = videoOf(container);
    fakeMedia(video);
    act(() => {
      video.currentTime = 2;
    });
    expect(video.hidden).toBe(false);
    expect(container.querySelector("output")?.getAttribute("data-frame")).toBe("60");
  });
  it("renders the controls with accessible names, the stale badge and render facts", () => {
    const { container } = renderWith(<VideoViewer project="promo-acme" media={scene} composition="Scene3" />);
    const video = videoOf(container);
    expect(video.getAttribute("src")).toBe("/media/promo-acme/@out/scenes/scene-3.mp4");
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video?.getAttribute("aria-label")).toBe("Player: Scene 3");
    const play = screen.getByRole("button", { name: "Play" });
    expect(play?.getAttribute("data-hotkey")).toBe("play");
    expect(screen.getByRole("button", { name: /Previous frame/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next frame/ })).toBeTruthy();
    const scrub = screen.getByRole("slider", { name: "Position" });
    expect(scrub?.getAttribute("aria-valuemax")).toBe("125");
    expect(scrub?.getAttribute("aria-valuetext")).toBe("Frame 0 of 126, 00:00:00");
    expect(selectValue(screen.getByRole("combobox", { name: "Playback rate" }))).toBe("1");
    expect(container.querySelector("[data-stale]")?.textContent).toContain("Stale");
    expect(screen.getAllByText("The composition changed since this render").length).toBeGreaterThan(0);
    expect(screen.getByText("Source cccccccc")?.getAttribute("title")).toBe("c".repeat(64));
    // inline without a handler: no comment action
    expect(screen.queryByRole("button", { name: "Comment on this frame" })).toBeNull();
  });

  it("shows a lazy frame strip from /thumb and seeks on click", () => {
    const { container } = renderWith(<VideoViewer project="promo-acme" media={scene} />);
    const media = fakeMedia(videoOf(container));
    const strip = screen.getByRole("list", { name: "Frames of Scene 3" });
    const frames = within(strip).getAllByRole("button");
    expect(frames).toHaveLength(8);
    const img = frames[0]!.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toMatch(/^\/thumb\/promo-acme\/@out\/scenes\/scene-3\.mp4\?t=0\.3&w=160$/);
    fireEvent.click(frames[4]!);
    expect(media.time()).toBeCloseTo(2.4); // 4.5 slices of 0.525 s, on the 0.1 s grid
    expect(frames[4]?.getAttribute("aria-current")).toBe("true");
    // a refused frame (503 BUSY) is retried once with the same URL; a second failure leaves a plain tile
    vi.useFakeTimers();
    fireEvent.error(img);
    expect(frames[0]!.querySelector("img")).toBeNull();
    act(() => vi.advanceTimersByTime(THUMB_RETRY_MS));
    const retried = frames[0]!.querySelector("img")!;
    expect(retried.getAttribute("src")).toBe(img.getAttribute("src"));
    fireEvent.error(retried);
    act(() => vi.advanceTimersByTime(THUMB_RETRY_MS));
    expect(frames[0]!.querySelector("img")).toBeNull();
  });

  it("plays, steps frames with buttons and keys, and seeks by frame", () => {
    const { container } = renderWith(<VideoViewer project="promo-acme" media={scene} />);
    const video = videoOf(container);
    const media = fakeMedia(video);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(video.play).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next frame/ }));
    expect(video.pause).toHaveBeenCalled();
    expect(media.time()).toBeCloseTo(timeOfFrame(1, 30));
    expect(container.querySelector("output")?.getAttribute("data-frame")).toBe("1");
    fireEvent.keyDown(video, { key: "ArrowRight", shiftKey: true });
    expect(container.querySelector("output")?.getAttribute("data-frame")).toBe("31");
    fireEvent.keyDown(video, { key: "ArrowLeft" });
    expect(container.querySelector("output")?.textContent).toContain("00:01:00 · Frame 30 / 126");
    fireEvent.keyDown(video, { key: "End" });
    expect(container.querySelector("output")?.getAttribute("data-frame")).toBe("125");
    setSlider(screen.getByRole("slider", { name: "Position" }), 60);
    expect(media.time()).toBeCloseTo(timeOfFrame(60, 30));
    fireEvent.keyDown(video, { key: " " });
    expect(video.play).toHaveBeenCalledTimes(2);
    chooseOption(screen.getByRole("combobox", { name: "Playback rate" }), "0.5");
    expect(video.playbackRate).toBe(0.5);
  });

  it("leaves k to the card shortcuts (FR9) and plays on space only", () => {
    const { container } = renderWith(<VideoViewer project="promo-acme" media={scene} />);
    const video = videoOf(container);
    fakeMedia(video);
    const k = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
    video.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    video.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("labels an assumed frame rate", () => {
    const { container } = renderWith(
      <VideoViewer project="p" media={{ kind: "video", path: "a.mp4", durationSec: 1 }} />,
    );
    expect(container.querySelector("output")?.textContent).toContain("30 fps assumed");
  });

  it("emits a typed FrameComment from the numeric form (keyboard path)", () => {
    const onFrameComment = vi.fn();
    const { container } = renderWith(
      <VideoViewer project="promo-acme" media={scene} onFrameComment={onFrameComment} />,
    );
    const video = videoOf(container);
    fakeMedia(video);
    setSlider(screen.getByRole("slider", { name: "Position" }), 42);
    fireEvent.click(screen.getByRole("button", { name: "Comment on this frame" }));
    const form = screen.getByRole("form", { name: /Comment on frame 42/ });
    expect((within(form).getByRole("spinbutton", { name: "Frame" }) as HTMLInputElement).value).toBe("42");
    fireEvent.change(within(form).getByRole("spinbutton", { name: "Left" }), { target: { value: "0.1" } });
    fireEvent.change(within(form).getByRole("spinbutton", { name: "Top" }), { target: { value: "0.2" } });
    fireEvent.change(within(form).getByRole("spinbutton", { name: "Width" }), { target: { value: "0.3" } });
    fireEvent.change(within(form).getByRole("spinbutton", { name: "Height" }), { target: { value: "0.4" } });
    // the typed region shows over the picture
    const rect = container.querySelector<HTMLElement>("[data-region-rect]")!;
    expect([rect.style.left, rect.style.top]).toEqual(["10%", "20%"]);
    fireEvent.click(within(form).getByRole("button", { name: "Add comment" }));
    expect(within(form).getByRole("alert")?.textContent).toContain("Write a comment first.");
    expect(within(form).getByRole("textbox", { name: "Comment" })?.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment" }), { target: { value: "Logo too small" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add comment" }));
    expect(onFrameComment).toHaveBeenCalledTimes(1);
    const comment = FrameCommentSchema.parse(onFrameComment.mock.calls[0]![0]);
    expect(comment).toEqual({
      media: scene,
      frame: 42,
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      text: "Logo too small",
    });
    expect(screen.getByText("Comment added to frame 42.")).toBeTruthy();
  });

  it("turns a pointer drag over the picture into a normalised region", () => {
    const onFrameComment = vi.fn();
    const { container } = renderWith(
      <FrameCommentProvider value={onFrameComment}>
        <VideoViewer project="promo-acme" media={scene} />
      </FrameCommentProvider>,
    );
    fakeMedia(videoOf(container));
    fireEvent.click(screen.getByRole("button", { name: "Comment on this frame" }));
    const overlay = container.querySelector<HTMLElement>("[data-region-overlay]")!;
    overlay.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 400,
      right: 200,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(overlay, { button: 0, clientX: 50, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 150, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 150, clientY: 200, pointerId: 1 });
    expect((screen.getByRole("spinbutton", { name: "Left" }) as HTMLInputElement).value).toBe("0.25");
    expect((screen.getByRole("spinbutton", { name: "Height" }) as HTMLInputElement).value).toBe("0.25");
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "here" } });
    fireEvent.submit(screen.getByRole("form"));
    expect(onFrameComment.mock.calls[0]![0]).toMatchObject({ frame: 0, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.25 } });
  });

  it("in the large view without a handler, offers the comment as text to copy", () => {
    const { container } = renderWith(<VideoViewer project="promo-acme" media={scene} variant="full" />);
    fakeMedia(videoOf(container));
    fireEvent.click(screen.getByRole("button", { name: "Comment on this frame" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "too dark" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    const block = container.querySelector<HTMLElement>("[data-frame-comment]")!;
    expect(JSON.parse(block.dataset.frameComment!)).toMatchObject({ frame: 0, text: "too dark" });
    expect(block?.textContent).toContain("out/scenes/scene-3.mp4 frame 0 (00:00:00): too dark");
  });

  it("where Studio cannot open the project, says why and copies the Studio command without network", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const store = fixtureStore(new FixtureApiClient({ fixture: "view-campaign", now: () => FIXTURE_NOW }));
    renderWith(<VideoViewer project="spring-campaign" media={scene} variant="full" composition="PromoScene3" />, {
      store,
    });
    const open = await screen.findByRole("button", { name: "Open in Remotion Studio" });
    expect(screen.getByText(/Studio cannot open this project: A campaign container/)).toBeTruthy();
    expect(open?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(open?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("pnpm studio")).toBeTruthy();
    expect(screen.getByText(/then open the composition PromoScene3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("pnpm studio\n# then open the composition PromoScene3");
  });

  it("falls back to a tile when the render cannot be loaded", () => {
    const { container } = renderWith(<VideoViewer project="promo-acme" media={scene} />);
    fireEvent.error(videoOf(container));
    expect(container.querySelector("video")?.hidden).toBe(true);
    expect(container.querySelector("[data-media-unavailable]")?.getAttribute("title")).toBe("Could not load Scene 3");
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  });

  it("switches to a scene picked from its strip", () => {
    const other: MediaRef = { ...scene, path: "scenes/scene-4.mp4", label: "Scene 4", stale: false };
    const { container } = renderWith(<VideoViewer project="promo-acme" media={scene} scenes={[scene, other]} />);
    const strips = screen.getByRole("region", { name: "Scenes" });
    const scene4 = within(strips).getByRole("list", { name: "Frames of Scene 4" });
    fireEvent.click(within(scene4).getAllByRole("button")[0]!);
    expect(videoOf(container).getAttribute("src")).toBe("/media/promo-acme/@out/scenes/scene-4.mp4");
  });
});

describe("MediaSlot", () => {
  it("thumb: a lazy poster with the play hotkey, no <video>, icon on error", () => {
    const { container } = renderWith(<MediaSlot project="promo-acme" media={scene} variant="thumb" />);
    expect(container.querySelector("video")).toBeNull();
    const button = screen.getByRole("button", { name: "Open Scene 3" });
    expect(button?.getAttribute("data-hotkey")).toBe("play");
    const img = button.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/thumb/promo-acme/@out/scenes/scene-3.mp4?t=1&w=320");
    expect(img.getAttribute("loading")).toBe("lazy");
    vi.useFakeTimers();
    fireEvent.error(img);
    act(() => vi.advanceTimersByTime(THUMB_RETRY_MS));
    fireEvent.error(button.querySelector("img")!);
    expect(button.querySelector("img")).toBeNull();
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("thumb: opens the large viewer in a dialog", () => {
    renderWith(<MediaSlot project="promo-acme" media={{ ...scene, path: "scenes/x.mp4" }} variant="thumb" />);
    fireEvent.click(screen.getByRole("button", { name: /Open Scene 3/ }));
    const dialog = screen.getByRole("dialog", { name: "Large view of Scene 3" });
    expect(dialog.querySelector("video")).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Comment on this frame" })).toBeTruthy();
  });

  it("image: opens the lightbox; audio and documents get their own views", () => {
    renderWith(
      <>
        <MediaSlot project="p" media={{ kind: "image", path: "design/sf 1.png", label: "Styleframe 1" }} />
        <MediaSlot project="p" media={{ kind: "document", path: "script.md" }} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Open script.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Styleframe 1" }));
    const dialog = screen.getByRole("dialog", { name: "Large view of Styleframe 1" });
    expect(within(dialog).getByRole("img", { name: "Styleframe 1" }).getAttribute("src")).toBe(
      "/media/p/design/sf%201.png",
    );
  });

  it("opens a strategy document in place and saves only on an explicit action", async () => {
    const revision = "a".repeat(64);
    const original = { text: '{"proposition":"Before"}', revision, editable: true };
    const document = vi
      .fn()
      .mockImplementation(async (_project, { path }) =>
        path.endsWith(".md") ? { ...original, text: "# Original strategy" } : original,
      );
    const saveDocument = vi.fn().mockResolvedValue(original);
    const client = Object.assign(new FixtureApiClient(), { document, saveDocument });
    const { rerender } = renderWith(
      <MediaSlot project="p" media={{ kind: "document", path: "pipeline/strategy.json" }} />,
      {
        store: fixtureStore(client),
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Open strategy.json" }));
    const modal = screen.getByRole("dialog", { name: "strategy.json" });
    expect(await within(modal).findByText(original.text)).toBeTruthy();
    fireEvent.click(within(modal).getByRole("button", { name: "strategy.md" }));
    expect(await within(modal).findByText("# Original strategy")).toBeTruthy();
    fireEvent.click(within(modal).getByRole("button", { name: "strategy.json" }));
    expect(await within(modal).findByText(original.text)).toBeTruthy();
    fireEvent.click(within(modal).getByRole("button", { name: "Edit" }));
    const editor = within(modal).getByRole("textbox", { name: "Document contents" });
    const text = '{"proposition":"After"}';
    fireEvent.change(editor, { target: { value: text } });
    rerender(<p>The approval card refreshed.</p>);
    expect((editor as HTMLTextAreaElement).value).toBe(text);
    fireEvent.click(within(modal).getByText("Close", { selector: "button" }));
    expect(within(modal).getByText("This document has unsaved changes.")).toBeTruthy();
    expect(saveDocument).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole("button", { name: "Keep editing" }));
    fireEvent.click(within(modal).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saveDocument).toHaveBeenCalledWith("p", { path: "pipeline/strategy.json", text, revision });
  });
});

describe("AudioPlayer", () => {
  it("resumes time updates after a failed source is replaced", () => {
    const media: MediaRef = { kind: "audio", path: "missing.mp3", durationSec: 20 };
    const { container, rerender } = renderWith(<AudioPlayer project="promo-acme" media={media} />);
    fireEvent.error(container.querySelector("audio")!);
    expect(container.querySelector("[data-media-unavailable]")).not.toBeNull();
    rerender(<AudioPlayer project="promo-acme" media={{ ...media, path: "replacement.mp3" }} />);
    const audio = container.querySelector("audio")!;
    fakeMedia(audio, 20);
    act(() => {
      audio.currentTime = 2;
    });
    expect(container.querySelector("[data-media-unavailable]")).toBeNull();
    expect((screen.getByRole("slider", { name: "Position" }) as HTMLInputElement).value).toBe("2");
  });
  it("falls back to a plain bar without Web Audio and draws cue markers", async () => {
    renderWith(
      <AudioPlayer
        project="promo-acme"
        media={{ kind: "audio", path: "music/track-02.mp3", label: "Track 2", durationSec: 20 }}
        cues={[{ t: 5, label: "drop", strong: true }, { t: 10 }]}
      />,
    );
    expect(screen.getByRole("button", { name: "Play" })?.getAttribute("data-hotkey")).toBe("play");
    expect(screen.getByRole("slider", { name: "Position" })?.getAttribute("max")).toBe("20");
    await waitFor(() => expect(screen.getByText(/Waveform not drawn/)).toBeTruthy());
    const cues = document.querySelectorAll<HTMLElement>("[data-cue]");
    expect(cues).toHaveLength(2);
    expect(cues[0]!.style.left).toBe("25%");
    expect(cues[0]?.getAttribute("title")).toBe("drop at 0:05");
  });
});

describe("Compare", () => {
  const a: MediaRef = {
    root: "out",
    path: "endings/ending-a.mp4",
    kind: "video",
    label: "Ending A",
    durationSec: 3,
    fps: 30,
  };
  const b: MediaRef = { ...a, path: "endings/ending-b.mp4", label: "Ending B" };

  it("shows A and B side by side, then as a wipe with a labelled slider", () => {
    const { container } = renderWith(<Compare project="promo-acme" a={a} b={b} />);
    expect(screen.getByRole("region", { name: "Compare Ending A and Ending B" }).getAttribute("data-compare")).toBe(
      "side",
    );
    expect(container.querySelectorAll("video")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    expect(screen.getByRole("button", { name: "Wipe" })?.getAttribute("aria-pressed")).toBe("true");
    const slider = screen.getByRole("slider", { name: "Wipe position" });
    setSlider(slider, 30);
    const videos = container.querySelectorAll("video");
    expect(videos[1]!.style.clipPath).toBe("inset(0px 0px 0px 30%)");
    expect(videos[1]!.muted).toBe(true);
  });
});

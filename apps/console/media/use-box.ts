/** Size of an element, kept current with a ResizeObserver (zero until measured, and in jsdom). */
import { useEffect, useState, type RefObject } from "react";

export function useBox(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBox((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

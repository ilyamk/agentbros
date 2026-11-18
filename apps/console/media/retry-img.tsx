/**
 * A lazily loaded thumbnail that retries once: the thumbnail service refuses bursts beyond its queue with 503 `BUSY`,
 * so a first failure remounts the same URL after a short delay; only a second failure leaves the plain tile. Failure
 * is per component, never remembered for the session.
 */
import { useEffect, useState, type ReactNode } from "react";

export const THUMB_RETRY_MS = 1500;

export function RetryImg({
  src,
  className,
  fallback = null,
}: {
  src: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
    setWaiting(false);
  }, [src]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setWaiting(false);
      setAttempt(1);
    }, THUMB_RETRY_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  if (failed || waiting) return <>{fallback}</>;
  return (
    <img
      key={attempt}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className={className}
      onError={() => (attempt === 0 ? setWaiting(true) : setFailed(true))}
    />
  );
}

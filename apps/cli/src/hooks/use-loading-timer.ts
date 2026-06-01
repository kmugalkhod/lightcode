import { useEffect, useRef, useState } from "react";

/**
 * Hook to track elapsed time while loading is active.
 * Updates every 100ms for smooth display.
 *
 * @param isActive - Whether the timer should be running
 * @returns The elapsed time in seconds
 */
export function useLoadingTimer(isActive: boolean): number {
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive) {
      // Clear interval and reset when inactive
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      startTimeRef.current = null;
      setElapsedSeconds(0);
      return;
    }

    // Initialize start time if not already set
    if (startTimeRef.current === null) {
      startTimeRef.current = Date.now();
    }

    // Set up interval to update every 100ms
    intervalRef.current = setInterval(() => {
      if (startTimeRef.current !== null) {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        setElapsedSeconds(elapsed);
      }
    }, 100);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isActive]);

  return elapsedSeconds;
}

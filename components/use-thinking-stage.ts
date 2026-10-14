"use client";

import { useEffect, useRef, useState } from "react";

const THINKING_STAGE_INTERVAL_MS = 1400;

/**
 * Cycles a stage index 0..stageCount-1 on a timer while `active` — a client-side approximation
 * of backend progress (none of the chat endpoints emit real intermediate progress events), so
 * the chat doesn't sit blank while work is happening. Returns the current stage and a reset.
 */
export function useThinkingStage(active: boolean, stageCount: number): [number, () => void] {
  const [stage, setStage] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (active) {
      timer.current = setInterval(() => setStage((i) => (i + 1) % stageCount), THINKING_STAGE_INTERVAL_MS);
    } else if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return [stage, () => setStage(0)];
}

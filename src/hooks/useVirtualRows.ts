import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export interface VisibleWindowInput {
  scrollTop: number;
  viewportH: number;
  rowHeight: number;
  rowCount: number;
  overscan: number;
}

export interface VisibleWindow {
  startIndex: number;
  endIndex: number;
  topPad: number;
  bottomPad: number;
}

/**
 * Pure windowing math. Given the scroll position, viewport height, fixed row
 * height and total row count, return the inclusive [startIndex, endIndex] of
 * rows to render (± overscan) plus the spacer heights above/below. No React,
 * no DOM — unit-testable in Node.
 */
export function computeVisibleWindow({
  scrollTop,
  viewportH,
  rowHeight,
  rowCount,
  overscan,
}: VisibleWindowInput): VisibleWindow {
  if (rowCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: -1, topPad: 0, bottomPad: 0 };
  }
  const first = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportH / rowHeight);
  const startIndex = Math.max(0, first - overscan);
  const endIndex = Math.min(rowCount - 1, first + visibleCount + overscan);
  const topPad = startIndex * rowHeight;
  const bottomPad = Math.max(0, (rowCount - 1 - endIndex) * rowHeight);
  return { startIndex, endIndex, topPad, bottomPad };
}

export interface UseVirtualRowsOptions {
  rowCount: number;
  rowHeight: number;
  overscan?: number;
}

export interface UseVirtualRows extends VisibleWindow {
  onScroll: (e: { currentTarget: { scrollTop: number; clientHeight: number } }) => void;
  scrollRef: RefObject<HTMLDivElement>;
}

/**
 * React wrapper around computeVisibleWindow. Attach `scrollRef` to the scroll
 * container and `onScroll` to its onScroll; render rows
 * [startIndex..endIndex] between a topPad and bottomPad spacer.
 */
export function useVirtualRows({ rowCount, rowHeight, overscan = 6 }: UseVirtualRowsOptions): UseVirtualRows {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: { currentTarget: { scrollTop: number; clientHeight: number } }) => {
    setScrollTop(e.currentTarget.scrollTop);
    setViewportH(e.currentTarget.clientHeight);
  }, []);

  const win = computeVisibleWindow({ scrollTop, viewportH: viewportH || 600, rowHeight, rowCount, overscan });
  return { ...win, onScroll, scrollRef };
}

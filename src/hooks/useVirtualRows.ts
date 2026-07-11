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
  scrollRef?: RefObject<HTMLDivElement>;
  enabled?: boolean;
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
export function useVirtualRows({
  rowCount,
  rowHeight,
  overscan = 6,
  scrollRef: providedScrollRef,
  enabled = true,
}: UseVirtualRowsOptions): UseVirtualRows {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = providedScrollRef ?? internalScrollRef;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const pendingMetricsRef = useRef<{ scrollTop: number; viewportH: number } | null>(null);
  const scrollFrameRef = useRef(0);

  const commitMetrics = useCallback((nextScrollTop: number, nextViewportH: number) => {
    setScrollTop((current) => (current === nextScrollTop ? current : nextScrollTop));
    setViewportH((current) => (current === nextViewportH ? current : nextViewportH));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    commitMetrics(el.scrollTop, el.clientHeight);
    const ro = new ResizeObserver(() => commitMetrics(el.scrollTop, el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (scrollFrameRef.current) window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = 0;
      pendingMetricsRef.current = null;
    };
  }, [commitMetrics, enabled, scrollRef]);

  const onScroll = useCallback((e: { currentTarget: { scrollTop: number; clientHeight: number } }) => {
    pendingMetricsRef.current = {
      scrollTop: e.currentTarget.scrollTop,
      viewportH: e.currentTarget.clientHeight,
    };
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      const pending = pendingMetricsRef.current;
      pendingMetricsRef.current = null;
      if (pending) commitMetrics(pending.scrollTop, pending.viewportH);
    });
  }, [commitMetrics]);

  const win = computeVisibleWindow({ scrollTop, viewportH: viewportH || 600, rowHeight, rowCount, overscan });
  return { ...win, onScroll, scrollRef };
}

export interface GridColumnCountInput {
  containerWidth: number;
  minItemWidth: number;
  gap: number;
  horizontalPadding?: number;
}

/** Match CSS grid's `repeat(auto-fill, minmax(...))` column count. */
export function computeGridColumnCount({
  containerWidth,
  minItemWidth,
  gap,
  horizontalPadding = 0,
}: GridColumnCountInput): number {
  const available = Math.max(0, containerWidth - horizontalPadding);
  const stride = Math.max(1, minItemWidth + gap);
  return Math.max(1, Math.floor((available + gap) / stride));
}

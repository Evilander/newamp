import { useEffect } from 'react';
import { api } from '../lib/api';
import { hasStreamingSources, isStreamingView, useSidebarLayout } from '../store/useSidebarLayout';

function lookForStreamingSources(): void {
  if (useSidebarLayout.getState().streamingUsed) return;
  void hasStreamingSources(api).then((found) => {
    if (found) useSidebarLayout.getState().markStreamingUsed();
  });
}

/**
 * Notes in the sidebar layout once the library has a music server or a podcast
 * feed, which opens the Streaming group by default from then on. Servers and
 * feeds are added in their own views, so the lookup runs at start and again
 * when the person leaves one of those views, and stops for good once it finds
 * something. Stations are not saved, so being in Radio counts as having one.
 */
export function useStreamingPresence(view: string): void {
  const used = useSidebarLayout((s) => s.streamingUsed);
  const markStreamingUsed = useSidebarLayout((s) => s.markStreamingUsed);

  useEffect(() => {
    if (view === 'radio') markStreamingUsed();
  }, [view, markStreamingUsed]);

  useEffect(() => {
    if (!used) lookForStreamingSources();
    // Once, at start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (used || !isStreamingView(view)) return undefined;
    return lookForStreamingSources;
  }, [used, view]);
}

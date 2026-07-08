import { useEffect, useMemo, useState } from 'react';
import type { PodcastEpisode, PodcastSubscription } from '@shared/types';
import { api } from '../../lib/api';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatTime } from '../../lib/format';
import { pushToast } from '../../lib/toast';
import { ConfirmAction } from '../ConfirmAction';

/** Busy keys are per-target so a long episode download doesn't freeze the
 *  whole view: 'add', `feed:${url}`, `episode:${id}`. Feed list refreshes
 *  always re-fetch from the main process, so concurrent ops converge. */
function feedKey(url: string): string {
  return `feed:${url}`;
}

function episodeKey(id: string): string {
  return `episode:${id}`;
}

export function PodcastView(): JSX.Element {
  const [subscriptions, setSubscriptions] = useState<PodcastSubscription[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [feedUrl, setFeedUrl] = useState('');
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const playPodcastEpisode = usePlayerStore((state) => state.playPodcastEpisode);

  useEffect(() => {
    void refreshList();
  }, []);

  const selected = useMemo(
    () => subscriptions.find((subscription) => subscription.feed.url === selectedUrl) ?? subscriptions[0] ?? null,
    [subscriptions, selectedUrl],
  );

  const isBusy = (key: string): boolean => busyKeys.has(key);

  function markBusy(key: string, on: boolean): void {
    setBusyKeys((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function refreshList(): Promise<void> {
    const next = await api.listPodcastSubscriptions().catch(() => []);
    setSubscriptions(next);
    setSelectedUrl((current) => current && next.some((item) => item.feed.url === current) ? current : next[0]?.feed.url ?? null);
  }

  async function addFeed(): Promise<void> {
    const url = feedUrl.trim();
    if (!url || isBusy('add')) return;
    markBusy('add', true);
    try {
      const subscription = await api.subscribePodcastFeed(url);
      await refreshList();
      setSelectedUrl(subscription.feed.url);
      setFeedUrl('');
      pushToast({ tone: 'ok', title: 'Feed added', detail: subscription.feed.title });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Feed add failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      markBusy('add', false);
    }
  }

  async function refreshFeed(url: string): Promise<void> {
    if (isBusy(feedKey(url))) return;
    markBusy(feedKey(url), true);
    try {
      const subscription = await api.refreshPodcastFeed(url);
      await refreshList();
      setSelectedUrl(subscription.feed.url);
      pushToast({ tone: 'ok', title: 'Feed refreshed', detail: subscription.feed.title });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Feed refresh failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      markBusy(feedKey(url), false);
    }
  }

  async function removeFeed(url: string): Promise<void> {
    if (isBusy(feedKey(url))) return;
    const title = subscriptions.find((subscription) => subscription.feed.url === url)?.feed.title;
    markBusy(feedKey(url), true);
    try {
      await api.removePodcastFeed(url);
      await refreshList();
      pushToast({ tone: 'ok', title: 'Feed removed', detail: title });
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Feed removal failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      markBusy(feedKey(url), false);
    }
  }

  async function playEpisode(episode: PodcastEpisode): Promise<void> {
    await playPodcastEpisode(episode);
  }

  async function downloadEpisode(episode: PodcastEpisode): Promise<void> {
    if (isBusy(episodeKey(episode.id))) return;
    markBusy(episodeKey(episode.id), true);
    try {
      const updated = await api.downloadPodcastEpisode(episode.feedUrl, episode.id);
      if (updated) {
        applyEpisodeUpdate(updated);
        pushToast({ tone: 'ok', title: 'Episode downloaded', detail: updated.title });
      } else {
        pushToast({ tone: 'warn', title: 'Episode download was not available', detail: episode.title });
      }
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Episode download failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      markBusy(episodeKey(episode.id), false);
    }
  }

  async function removeEpisodeDownload(episode: PodcastEpisode): Promise<void> {
    if (isBusy(episodeKey(episode.id))) return;
    markBusy(episodeKey(episode.id), true);
    try {
      const updated = await api.removePodcastEpisodeDownload(episode.feedUrl, episode.id);
      if (updated) {
        applyEpisodeUpdate(updated);
        pushToast({ tone: 'ok', title: 'Local file removed', detail: updated.title });
      } else {
        pushToast({ tone: 'warn', title: 'Downloaded episode was not found', detail: episode.title });
      }
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Downloaded episode removal failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      markBusy(episodeKey(episode.id), false);
    }
  }

  function applyEpisodeUpdate(updated: PodcastEpisode): void {
    setSubscriptions((current) =>
      current.map((subscription) =>
        subscription.feed.url === updated.feedUrl
          ? {
              ...subscription,
              episodes: subscription.episodes.map((episode) =>
                episode.id === updated.id ? updated : episode,
              ),
            }
          : subscription,
      ),
    );
    setSelectedUrl(updated.feedUrl);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold">Podcasts</span>
          <input
            value={feedUrl}
            onChange={(event) => setFeedUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addFeed();
            }}
            placeholder="Paste an RSS feed URL..."
            className="bevel-in lcd-text ml-2 flex-1 px-3 py-1.5 text-[14px] outline-none"
            style={{ background: 'var(--display-bg)', color: 'var(--display-fg)' }}
          />
          <button className="pxbtn is-active" onClick={() => void addFeed()} disabled={isBusy('add') || !feedUrl.trim()}>
            {isBusy('add') ? 'Adding…' : 'Add feed'}
          </button>
        </div>
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted)' }}>
          <span>{subscriptions.length.toLocaleString()} feeds</span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
        <aside className="overflow-auto border-r" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
          {subscriptions.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--muted)' }}>
              Add a podcast RSS feed to build a local subscription list.
            </div>
          ) : (
            <ul className="m-0 list-none p-0">
              {subscriptions.map((subscription) => (
                <li key={subscription.feed.url}>
                  <button
                    className="flex w-full items-center gap-3 border-b px-3 py-3 text-left hover:bg-[var(--panel-2)]"
                    style={{
                      borderColor: 'var(--line)',
                      background: selected?.feed.url === subscription.feed.url ? 'var(--panel-2)' : 'transparent',
                      color: selected?.feed.url === subscription.feed.url ? 'var(--accent)' : 'var(--ink)',
                    }}
                    onClick={() => setSelectedUrl(subscription.feed.url)}
                  >
                    {subscription.feed.imageUrl ? (
                      <img src={subscription.feed.imageUrl} alt="" className="h-10 w-10 object-cover" style={{ borderRadius: 'var(--radius)' }} />
                    ) : (
                      <div className="h-10 w-10 shrink-0 bevel-in" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{subscription.feed.title}</span>
                      <span className="block truncate text-[10px]" style={{ color: 'var(--muted)' }}>
                        {isBusy(feedKey(subscription.feed.url))
                          ? 'Working…'
                          : `${subscription.feed.episodeCount.toLocaleString()} episodes`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="min-w-0 overflow-auto">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
              No podcast selected.
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex gap-4 border-b p-4" style={{ borderColor: 'var(--line)' }}>
                {selected.feed.imageUrl && (
                  <img src={selected.feed.imageUrl} alt="" className="h-24 w-24 object-cover" style={{ borderRadius: 'var(--radius)' }} />
                )}
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-xl font-bold">{selected.feed.title}</h1>
                  <p className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--muted)' }}>
                    {selected.feed.description || selected.feed.url}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="pxbtn"
                      onClick={() => void refreshFeed(selected.feed.url)}
                      disabled={isBusy(feedKey(selected.feed.url))}
                    >
                      {isBusy(feedKey(selected.feed.url)) ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <ConfirmAction
                      label="Remove"
                      confirmLabel="Sure?"
                      tone="error"
                      title="Unsubscribe from this feed"
                      disabled={isBusy(feedKey(selected.feed.url))}
                      onConfirm={() => void removeFeed(selected.feed.url)}
                    />
                  </div>
                </div>
              </div>

              <ul className="m-0 list-none p-0">
                {selected.episodes.map((episode) => (
                  <li
                    key={episode.id}
                    className="flex gap-3 border-b px-4 py-3 hover:bg-[var(--panel-2)]"
                    style={{ borderColor: 'var(--line)' }}
                  >
                    <button className="pxbtn h-8 !min-w-[70px]" onClick={() => void playEpisode(episode)}>
                      {episode.progressSeconds > 0 && !episode.completed ? 'Continue' : '▶'}
                    </button>
                    <div className="flex shrink-0 flex-col gap-1">
                      {episode.downloadPath ? (
                        <button
                          className="pxbtn !min-w-[70px]"
                          onClick={() => void removeEpisodeDownload(episode)}
                          disabled={isBusy(episodeKey(episode.id))}
                        >
                          {isBusy(episodeKey(episode.id)) ? 'Removing…' : 'Remove file'}
                        </button>
                      ) : (
                        <button
                          className="pxbtn !min-w-[70px]"
                          onClick={() => void downloadEpisode(episode)}
                          disabled={isBusy(episodeKey(episode.id))}
                        >
                          {isBusy(episodeKey(episode.id)) ? 'Downloading…' : 'Download'}
                        </button>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">{episode.title}</div>
                      <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                        {episode.description || episode.audioUrl}
                      </div>
                      {episode.downloadPath && (
                        <div className="mt-1 text-[10px]" style={{ color: 'var(--accent)' }}>
                          Downloaded {formatBytes(episode.downloadBytes)}
                        </div>
                      )}
                      <div className="mt-2 text-[10px]" style={{ color: 'var(--muted)' }}>
                        {episode.publishedAt ? new Date(episode.publishedAt).toLocaleDateString() : 'Undated'}
                        {episode.duration ? ` · ${formatTime(episode.duration)}` : ''}
                        {episode.completed ? ' · Played' : episode.progressSeconds > 0 ? ` · Progress ${formatTime(episode.progressSeconds)}` : ''}
                      </div>
                      {episode.duration && episode.progressSeconds > 0 && !episode.completed && (
                        <div className="mt-2 h-1 w-full overflow-hidden bevel-in">
                          <div
                            className="h-full"
                            style={{
                              width: `${Math.min(100, Math.max(0, (episode.progressSeconds / episode.duration) * 100))}%`,
                              background: 'var(--accent)',
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function formatBytes(value: number | null): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

import { useEffect, useMemo, useState } from 'react';
import type { PodcastEpisode, PodcastSubscription } from '@shared/types';
import { api } from '../../lib/api';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatTime } from '../../lib/format';

export function PodcastView(): JSX.Element {
  const [subscriptions, setSubscriptions] = useState<PodcastSubscription[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [feedUrl, setFeedUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const playPodcastEpisode = usePlayerStore((state) => state.playPodcastEpisode);

  useEffect(() => {
    void refreshList();
  }, []);

  const selected = useMemo(
    () => subscriptions.find((subscription) => subscription.feed.url === selectedUrl) ?? subscriptions[0] ?? null,
    [subscriptions, selectedUrl],
  );

  async function refreshList(): Promise<void> {
    const next = await api.listPodcastSubscriptions().catch(() => []);
    setSubscriptions(next);
    setSelectedUrl((current) => current && next.some((item) => item.feed.url === current) ? current : next[0]?.feed.url ?? null);
  }

  async function addFeed(): Promise<void> {
    const url = feedUrl.trim();
    if (!url) return;
    setBusy(true);
    setStatus('Adding feed...');
    try {
      const subscription = await api.subscribePodcastFeed(url);
      await refreshList();
      setSelectedUrl(subscription.feed.url);
      setFeedUrl('');
      setStatus(`Added ${subscription.feed.title}.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Feed add failed.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshFeed(url: string): Promise<void> {
    setBusy(true);
    setStatus('Refreshing feed...');
    try {
      const subscription = await api.refreshPodcastFeed(url);
      await refreshList();
      setSelectedUrl(subscription.feed.url);
      setStatus(`Refreshed ${subscription.feed.title}.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Feed refresh failed.');
    } finally {
      setBusy(false);
    }
  }

  async function removeFeed(url: string): Promise<void> {
    setBusy(true);
    try {
      await api.removePodcastFeed(url);
      await refreshList();
      setStatus('Feed removed.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Feed removal failed.');
    } finally {
      setBusy(false);
    }
  }

  async function playEpisode(episode: PodcastEpisode): Promise<void> {
    await playPodcastEpisode(episode);
  }

  async function downloadEpisode(episode: PodcastEpisode): Promise<void> {
    setBusy(true);
    setStatus('Downloading episode...');
    try {
      const updated = await api.downloadPodcastEpisode(episode.feedUrl, episode.id);
      if (updated) {
        applyEpisodeUpdate(updated);
        setStatus(`Downloaded ${updated.title}.`);
      } else {
        setStatus('Episode download was not available.');
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Episode download failed.');
    } finally {
      setBusy(false);
    }
  }

  async function removeEpisodeDownload(episode: PodcastEpisode): Promise<void> {
    setBusy(true);
    setStatus('Removing downloaded episode...');
    try {
      const updated = await api.removePodcastEpisodeDownload(episode.feedUrl, episode.id);
      if (updated) {
        applyEpisodeUpdate(updated);
        setStatus(`Removed local file for ${updated.title}.`);
      } else {
        setStatus('Downloaded episode was not found.');
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Downloaded episode removal failed.');
    } finally {
      setBusy(false);
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
          <button className="pxbtn is-active" onClick={() => void addFeed()} disabled={busy || !feedUrl.trim()}>
            Add feed
          </button>
        </div>
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted)' }}>
          <span>{subscriptions.length.toLocaleString()} feeds</span>
          {status && <span>{status}</span>}
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
                        {subscription.feed.episodeCount.toLocaleString()} episodes
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
                    <button className="pxbtn" onClick={() => void refreshFeed(selected.feed.url)} disabled={busy}>
                      Refresh
                    </button>
                    <button className="pxbtn" onClick={() => void removeFeed(selected.feed.url)} disabled={busy}>
                      Remove
                    </button>
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
                          disabled={busy}
                        >
                          Remove file
                        </button>
                      ) : (
                        <button
                          className="pxbtn !min-w-[70px]"
                          onClick={() => void downloadEpisode(episode)}
                          disabled={busy}
                        >
                          Download
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

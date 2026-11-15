import { useCallback, useEffect, useState } from 'react';
import type { ListSummary, Review, ReviewTargetType, SocialPrivacy, UserProfile } from '@shared/types';
import { api } from '../../lib/api';
import { pushToast } from '../../lib/toast';
import { ConfirmAction } from '../ConfirmAction';
import { EmptyState } from '../EmptyState';

const PRIVACY: SocialPrivacy[] = ['local', 'friends', 'public'];
const TARGETS: ReviewTargetType[] = ['album', 'artist', 'track'];
const MAX_FAVORITES = 5;

function failure(title: string, err: unknown): void {
  pushToast({ tone: 'error', title, detail: err instanceof Error ? err.message : undefined });
}

export function ProfileView(): JSX.Element {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);

  // Profile editor fields
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [favorites, setFavorites] = useState('');
  const [privacy, setPrivacy] = useState<SocialPrivacy>('local');

  // New list / review fields
  const [newListTitle, setNewListTitle] = useState('');
  const [reviewTarget, setReviewTarget] = useState<ReviewTargetType>('album');
  const [reviewKey, setReviewKey] = useState('');
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewBody, setReviewBody] = useState('');
  const [reviewRating, setReviewRating] = useState('');

  // The lists and reviews reload after every change to them; the Identity
  // fields are filled from the saved profile only on first load and after the
  // profile itself is saved, so text typed there survives a list or review action.
  const hydrateEditor = useCallback((p: UserProfile) => {
    setName(p.displayName);
    setBio(p.bio);
    setFavorites(p.favorites.join('; '));
    setPrivacy(p.defaultPrivacy);
  }, []);

  const loadCollections = useCallback(async (): Promise<UserProfile> => {
    const [p, l, r] = await Promise.all([api.getProfile(), api.getLists(), api.getReviews()]);
    setProfile(p);
    setLists(l);
    setReviews(r);
    return p;
  }, []);

  const refreshCollections = useCallback(async (): Promise<void> => {
    try {
      await loadCollections();
    } catch (err) {
      failure('Could not refresh your profile', err);
    }
  }, [loadCollections]);

  useEffect(() => {
    loadCollections().then(hydrateEditor, (err) => failure('Could not load your profile', err));
  }, [loadCollections, hydrateEditor]);

  // New lists and reviews take the privacy the profile has saved, not whatever
  // the Identity dropdown is showing before it is saved.
  const newItemPrivacy: SocialPrivacy = profile?.defaultPrivacy ?? 'local';

  const saveProfile = async (): Promise<void> => {
    const entries = favorites.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
    const favs = entries.slice(0, MAX_FAVORITES);
    try {
      await api.saveProfile({ displayName: name, bio, favorites: favs, defaultPrivacy: privacy });
      pushToast({
        tone: entries.length > favs.length ? 'warn' : 'ok',
        title: 'Profile saved',
        detail: entries.length > favs.length ? `Only the first ${MAX_FAVORITES} favorites are kept.` : undefined,
      });
      hydrateEditor(await loadCollections());
    } catch (err) {
      failure('Could not save your profile', err);
    }
  };

  const createList = async (): Promise<void> => {
    if (!newListTitle.trim()) {
      pushToast({ tone: 'warn', title: 'Give the list a title first' });
      return;
    }
    const title = newListTitle.trim();
    try {
      await api.saveList({ title, ranked: true, privacy: newItemPrivacy });
      setNewListTitle('');
      pushToast({ tone: 'ok', title: 'List created', detail: title });
    } catch (err) {
      failure('Could not create the list', err);
      return;
    }
    void refreshCollections();
  };

  const deleteList = async (list: ListSummary): Promise<void> => {
    try {
      await api.deleteList(list.id);
      pushToast({ tone: 'ok', title: 'List deleted', detail: list.title });
    } catch (err) {
      failure('Could not delete the list', err);
      return;
    }
    void refreshCollections();
  };

  const addReview = async (): Promise<void> => {
    if (!reviewKey.trim() || !reviewBody.trim()) {
      pushToast({ tone: 'warn', title: 'A review needs what it is about and your take' });
      return;
    }
    const ratingNum = reviewRating.trim() ? Math.max(0, Math.min(100, Number(reviewRating))) : null;
    try {
      await api.saveReview({
        targetType: reviewTarget,
        targetKey: reviewKey.trim(),
        title: reviewTitle.trim(),
        body: reviewBody.trim(),
        rating: Number.isFinite(ratingNum as number) ? ratingNum : null,
        privacy: newItemPrivacy,
      });
      setReviewKey('');
      setReviewTitle('');
      setReviewBody('');
      setReviewRating('');
      pushToast({ tone: 'ok', title: 'Review saved' });
    } catch (err) {
      failure('Could not save the review', err);
      return;
    }
    void refreshCollections();
  };

  const deleteReview = async (review: Review): Promise<void> => {
    try {
      await api.deleteReview(review.id);
      pushToast({
        tone: 'ok',
        title: 'Review deleted',
        detail: review.title || `${review.targetType} · ${review.targetKey}`,
      });
    } catch (err) {
      failure('Could not delete the review', err);
      return;
    }
    void refreshCollections();
  };

  const exportBundle = async (): Promise<void> => {
    try {
      const saved = await api.exportProfileBundle();
      if (saved) {
        pushToast({ tone: 'ok', title: 'Profile page exported', detail: 'Includes public lists and reviews, your profile, favorites, and top artists. Review the file before sharing.' });
      }
    } catch (err) {
      failure('Could not export the profile page', err);
    }
  };

  const freshProfile =
    profile !== null && lists.length === 0 && reviews.length === 0 && !profile.bio && profile.favorites.length === 0;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-[900px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[13px] font-bold tracking-[0.2em]" style={{ color: 'var(--accent)' }}>
              YOUR PROFILE
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight" style={{ color: 'var(--ink)' }}>
              {profile?.displayName || 'Local listener'}
            </h1>
          </div>
          <button
            className="pxbtn"
            onClick={() => void exportBundle()}
            title="Export your profile, favorites, top artists, and public lists and reviews"
          >
            SHARE PROFILE PAGE
          </button>
        </header>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Nothing is uploaded. The exported page includes your profile, favorites, top artists, and only lists and reviews marked public.
          Local and friends-only items stay out of the export. Review the file before sharing it.
        </p>

        {freshProfile && (
          <EmptyState
            size="panel"
            title="Make this page yours"
            body="Set a name and a line about your taste, pin five favorites, then share it — one HTML file you can post anywhere."
          />
        )}

        {/* Profile editor */}
        <section className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
          <SectionTitle>Identity</SectionTitle>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Display name">
              <input className="ninput w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </Field>
            <Field label="Default privacy">
              <select className="ninput w-full" value={privacy} onChange={(e) => setPrivacy(e.target.value as SocialPrivacy)}>
                {PRIVACY.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Bio" className="mt-3">
            <textarea className="ninput w-full" rows={2} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A line about your taste" />
          </Field>
          <Field label={`Five bags (favorites, up to ${MAX_FAVORITES}, separated by semicolons)`} className="mt-3">
            <input className="ninput w-full" value={favorites} onChange={(e) => setFavorites(e.target.value)} placeholder="OK Computer; Discovery; …" />
          </Field>
          <div className="mt-3">
            <button className="pxbtn" onClick={() => void saveProfile()}>SAVE PROFILE</button>
          </div>
        </section>

        {/* Lists */}
        <section className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
          <SectionTitle>Lists</SectionTitle>
          <div className="mt-3 flex gap-2">
            <input
              className="ninput flex-1"
              value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              placeholder="New list title — e.g. Best local recordings"
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') void createList();
              }}
            />
            <button className="pxbtn" onClick={() => void createList()}>ADD LIST</button>
          </div>
          {lists.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                size="panel"
                title="No lists yet"
                body="Rank your favorites — type a title above and press ADD LIST."
              />
            </div>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {lists.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 rounded px-3 py-2" style={{ background: 'var(--bg)' }}>
                  <span style={{ color: 'var(--ink)' }}>
                    {l.title} <span style={{ color: 'var(--muted)' }}>· {l.itemCount} items · {l.privacy}</span>
                  </span>
                  <ConfirmAction
                    label="✕"
                    confirmLabel="Sure?"
                    tone="error"
                    size="sm"
                    title="Delete list"
                    onConfirm={() => void deleteList(l)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Reviews */}
        <section className="rounded-lg p-5" style={{ background: 'var(--panel)' }}>
          <SectionTitle>Reviews &amp; diary</SectionTitle>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
            <select className="ninput" value={reviewTarget} onChange={(e) => setReviewTarget(e.target.value as ReviewTargetType)}>
              {TARGETS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input className="ninput sm:col-span-2" value={reviewKey} onChange={(e) => setReviewKey(e.target.value)} placeholder="What (album / artist / track)" />
            <input className="ninput" value={reviewRating} onChange={(e) => setReviewRating(e.target.value)} placeholder="Rating 0-100" inputMode="numeric" />
          </div>
          <input className="ninput mt-2 w-full" value={reviewTitle} onChange={(e) => setReviewTitle(e.target.value)} placeholder="Headline (optional)" />
          <textarea className="ninput mt-2 w-full" rows={2} value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} placeholder="Your take…" />
          <div className="mt-2">
            <button className="pxbtn" onClick={() => void addReview()}>SAVE REVIEW</button>
          </div>
          {reviews.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                size="panel"
                title="No reviews yet"
                body="Pick an album, artist, or track above and log your first take."
              />
            </div>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {reviews.map((r) => (
                <li key={r.id} className="rounded p-3" style={{ background: 'var(--bg)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ color: 'var(--ink)' }}>
                      {r.title || `${r.targetType} review`}
                      {r.rating != null && <span style={{ color: 'var(--accent)' }}> · {r.rating.toFixed(0)}/100</span>}
                    </span>
                    <ConfirmAction
                      label="✕"
                      confirmLabel="Sure?"
                      tone="error"
                      size="sm"
                      title="Delete review"
                      onConfirm={() => void deleteReview(r)}
                    />
                  </div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>{r.targetType} · {r.targetKey} · {r.privacy}</div>
                  {r.body && <p className="mt-1 text-sm" style={{ color: 'var(--ink)' }}>{r.body}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="text-[12px] font-bold tracking-[0.18em]" style={{ color: 'var(--accent)' }}>
      {String(children).toUpperCase()}
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-xs" style={{ color: 'var(--muted)' }}>{label}</span>
      {children}
    </label>
  );
}

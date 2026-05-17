export function LoadMoreFooter({
  shown,
  total,
  noun,
  hasMore,
  loading,
  loadLabel,
  onLoadMore,
}: {
  shown: number;
  total?: number | null;
  noun: string;
  hasMore: boolean;
  loading: boolean;
  loadLabel: string;
  onLoadMore: () => void;
}): JSX.Element | null {
  const knownTotal = typeof total === 'number' && Number.isFinite(total) ? Math.max(0, total) : null;
  if (!hasMore && (knownTotal === null || shown >= knownTotal)) return null;

  return (
    <div
      className="sticky bottom-0 flex items-center justify-between border-t px-3 py-2 text-[11px]"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--ink-2)' }}
    >
      <span>
        {knownTotal === null
          ? `${shown.toLocaleString()} ${noun} loaded`
          : `${shown.toLocaleString()} of ${knownTotal.toLocaleString()} ${noun} loaded`}
      </span>
      {hasMore && (
        <button className="pxbtn" onClick={onLoadMore} disabled={loading}>
          {loading ? 'Loading...' : loadLabel}
        </button>
      )}
    </div>
  );
}

// ViewSkeleton — shimmer placeholders for the three catalog shapes: table rows
// (var(--row-height)), a cover-card grid, and a horizontal rail. The shimmer
// is a subtle gradient sweep over an ink tint (reads on light skins too) and
// collapses to a static tint under prefers-reduced-motion — see
// styles/components/primitives.css (.view-skeleton / .skeleton-block).

import type { CSSProperties } from 'react';

export interface ViewSkeletonProps {
  variant: 'rows' | 'cards' | 'rails';
  count?: number;
}

const DEFAULT_COUNT: Record<ViewSkeletonProps['variant'], number> = {
  rows: 12,
  cards: 12,
  rails: 8,
};

export function ViewSkeleton({ variant, count }: ViewSkeletonProps): JSX.Element {
  const n = Math.max(1, count ?? DEFAULT_COUNT[variant]);
  const items = Array.from({ length: n }, (_, i) => i);
  return (
    <div
      className={`view-skeleton view-skeleton-${variant}`}
      data-newamp-skeleton={variant}
      role="status"
      aria-label="Loading"
      aria-busy="true"
    >
      {items.map((i) =>
        variant === 'rows' ? <SkeletonRow key={i} index={i} /> : <SkeletonCard key={i} index={i} />,
      )}
    </div>
  );
}

/** Staggers the sweep per item via a negative animation-delay (CSS side). */
function itemStyle(index: number): CSSProperties {
  return { '--skeleton-i': index } as CSSProperties;
}

/** Deterministic pseudo-random width so rows read organic, not striped. */
function barWidth(index: number, base: number, spread: number): string {
  return `${base + ((index * 37) % spread)}%`;
}

function SkeletonRow({ index }: { index: number }): JSX.Element {
  return (
    <div className="skeleton-row" style={itemStyle(index)}>
      <div className="skeleton-block skeleton-row-lead" />
      <div className="skeleton-block skeleton-row-bar" style={{ width: barWidth(index, 32, 30) }} />
      <div className="skeleton-block skeleton-row-bar skeleton-row-dim" style={{ width: barWidth(index + 3, 12, 14) }} />
      <div className="skeleton-block skeleton-row-tail" />
    </div>
  );
}

function SkeletonCard({ index }: { index: number }): JSX.Element {
  return (
    <div className="skeleton-card" style={itemStyle(index)}>
      <div className="skeleton-block skeleton-cover" />
      <div className="skeleton-block skeleton-card-bar" style={{ width: barWidth(index, 55, 35) }} />
      <div className="skeleton-block skeleton-card-bar skeleton-row-dim" style={{ width: barWidth(index + 5, 30, 25) }} />
    </div>
  );
}

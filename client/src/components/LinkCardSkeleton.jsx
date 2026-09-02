/**
 * Placeholder rows for the first load. Matching the real row's shape keeps the
 * list from jumping when the data arrives.
 */
export function LinkCardSkeleton() {
  return (
    <li className="lv-shimmer rounded-xl border border-line border-l-2 bg-surface p-4">
      <div className="h-4 w-1/3 rounded bg-surface-sunken" />
      <div className="mt-2.5 h-3 w-1/5 rounded bg-surface-muted" />
      <div className="mt-3 h-3 w-4/5 rounded bg-surface-muted" />
      <div className="mt-1.5 h-3 w-2/3 rounded bg-surface-muted" />
    </li>
  );
}

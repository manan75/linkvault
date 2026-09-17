/**
 * What rides under the cursor during a drag.
 *
 * Deliberately not the whole `LinkCard`: the card carries five buttons and a
 * link, none of which mean anything mid-drag, and a full-width copy of the row
 * obscures the very drop targets it is being carried towards.
 */
export function DragPreview({ link, title }) {
  return (
    <div className="flex max-w-xs items-center gap-2 rounded-xl border border-accent bg-surface px-3 py-2 text-sm font-medium shadow-2xl">
      {link.favicon ? (
        <img
          src={link.favicon}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-4 shrink-0 rounded-sm object-contain"
        />
      ) : null}
      <span className="truncate">{title}</span>
    </div>
  );
}

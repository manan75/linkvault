import { useDroppable } from '@dnd-kit/core';

import { TRASH_DROP_ID } from '../lib/dnd';

const TRASH_PATH = 'M6 7h12M10 7V5h4v2m-7 0 1 13h8l1-13';

/**
 * The bin, which only exists while something is being dragged.
 *
 * It stays mounted rather than appearing on drag start so that dnd-kit always
 * has it registered, and hides itself instead -- `pointer-events-none` does not
 * affect collision detection, which is rect-based, so nothing is lost by it
 * being invisible when no drag is happening.
 */
export function DeleteDropZone({ isDragging }) {
  const { setNodeRef, isOver } = useDroppable({ id: TRASH_DROP_ID });

  return (
    <div
      ref={setNodeRef}
      aria-hidden={!isDragging}
      className={`pointer-events-none fixed inset-x-0 bottom-6 z-20 mx-auto flex w-max items-center gap-2 rounded-full border-2 border-dashed px-5 py-3 text-sm font-medium shadow-lg transition-all duration-200 ${
        isDragging ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
      } ${
        isOver
          ? 'scale-105 border-danger bg-danger text-accent-ink'
          : 'border-line-strong bg-surface text-ink-muted'
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={TRASH_PATH} />
      </svg>
      {isOver ? 'Release to delete' : 'Drag here to delete'}
    </div>
  );
}

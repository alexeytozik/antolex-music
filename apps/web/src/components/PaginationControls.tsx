type PaginationControlsProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

function buildVisiblePages(page: number, totalPages: number) {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  return Array.from({ length: 5 }, (_, index) => start + index);
}

export function PaginationControls({
  page,
  totalPages,
  onPageChange,
}: PaginationControlsProps) {
  if (totalPages <= 1) {
    return null;
  }

  const visiblePages = buildVisiblePages(page, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="inline-flex h-10 items-center rounded-full border border-white/12 px-4 text-sm text-zinc-200 transition hover:border-emerald-300 hover:text-emerald-300 disabled:cursor-not-allowed disabled:border-white/5 disabled:text-zinc-600"
      >
        Prev
      </button>

      <div className="flex flex-wrap items-center gap-2">
        {visiblePages[0] > 1 && (
          <>
            <button
              type="button"
              onClick={() => onPageChange(1)}
              className="inline-flex h-10 min-w-10 items-center justify-center rounded-full border border-white/10 px-3 text-sm text-zinc-300 transition hover:border-emerald-300 hover:text-emerald-300"
            >
              1
            </button>
            {visiblePages[0] > 2 && (
              <span className="px-1 text-sm text-zinc-600">…</span>
            )}
          </>
        )}

        {visiblePages.map((pageNumber) => {
          const active = pageNumber === page;
          return (
            <button
              key={pageNumber}
              type="button"
              onClick={() => onPageChange(pageNumber)}
              aria-current={active ? "page" : undefined}
              className={`inline-flex h-10 min-w-10 items-center justify-center rounded-full border px-3 text-sm transition ${
                active
                  ? "border-emerald-400 bg-emerald-400 text-zinc-950"
                  : "border-white/10 text-zinc-300 hover:border-emerald-300 hover:text-emerald-300"
              }`}
            >
              {pageNumber}
            </button>
          );
        })}

        {visiblePages[visiblePages.length - 1] < totalPages && (
          <>
            {visiblePages[visiblePages.length - 1] < totalPages - 1 && (
              <span className="px-1 text-sm text-zinc-600">…</span>
            )}
            <button
              type="button"
              onClick={() => onPageChange(totalPages)}
              className="inline-flex h-10 min-w-10 items-center justify-center rounded-full border border-white/10 px-3 text-sm text-zinc-300 transition hover:border-emerald-300 hover:text-emerald-300"
            >
              {totalPages}
            </button>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="inline-flex h-10 items-center rounded-full border border-white/12 px-4 text-sm text-zinc-200 transition hover:border-emerald-300 hover:text-emerald-300 disabled:cursor-not-allowed disabled:border-white/5 disabled:text-zinc-600"
      >
        Next
      </button>
    </div>
  );
}

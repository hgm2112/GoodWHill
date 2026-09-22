"use client";

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl ${
          wide ? "sm:max-w-2xl" : "sm:max-w-lg"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost -mr-2 px-2 py-1 text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

export function NumberDollars({
  valueCents,
  onChange,
  placeholder,
  className,
}: {
  valueCents: number | null | undefined;
  onChange: (cents: number | null) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
        $
      </span>
      <input
        type="text"
        inputMode="decimal"
        className="input pl-7"
        placeholder={placeholder ?? "0.00"}
        value={valueCents == null ? "" : (valueCents / 100).toFixed(2)}
        onChange={(e) => {
          const cleaned = e.target.value.replace(/[^0-9.]/g, "");
          const n = Number.parseFloat(cleaned);
          onChange(cleaned && Number.isFinite(n) ? Math.round(n * 100) : null);
        }}
      />
    </div>
  );
}
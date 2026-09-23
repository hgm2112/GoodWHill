"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";

/** eBay thumbs like …/images/g/<hash>/s-l225.jpg enlarge to the largest published variant. */
function enlargeImageUrl(url: string): string {
  return url.replace(/s-l\d+\.(jpe?g|png|webp|gif)$/i, "s-l1600.$1");
}

/**
 * Inventory artwork: hovers to show a large popover on mouse devices, and
 * taps/clicks open a lightbox modal (bottom sheet on phones) on touch.
 * Never navigates away — reuse the surrounding thumbnail classes via
 * `className` so layouts are unchanged.
 */
export function ArtworkThumb({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const canHover = useMemo(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false),
    [],
  );
  const [hovering, setHovering] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`relative block cursor-zoom-in rounded-md text-left ${className ?? ""}`}
        onMouseEnter={canHover ? () => setHovering(true) : undefined}
        onMouseLeave={canHover ? () => setHovering(false) : undefined}
        onClick={() => {
          setHovering(false);
          setOpen(true);
        }}
        aria-label={alt ? `View ${alt} larger` : "View larger"}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? ""}
          className="pointer-events-none h-full w-full object-cover"
        />
      </button>

      {canHover && hovering && (
        <span className="pointer-events-none fixed left-1/2 top-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-2 shadow-2xl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enlargeImageUrl(src)}
            alt={alt ?? ""}
            className="max-h-[70vh] max-w-[70vw] object-contain"
          />
        </span>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={alt || "Artwork"} wide>
        <div className="flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enlargeImageUrl(src)}
            alt={alt ?? ""}
            className="max-h-[75dvh] rounded-md object-contain"
          />
        </div>
      </Modal>
    </>
  );
}
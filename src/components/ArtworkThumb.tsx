"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";

/** eBay thumbs like …/images/g/<hash>/s-l225.jpg enlarge to the largest published variant. */
function enlargeImageUrl(url: string): string {
  return url.replace(/s-l\d+\.(jpe?g|png|webp|gif)$/i, "s-l1600.$1");
}

/**
 * Inventory artwork: clicks/taps open a lightbox modal (bottom sheet on
 * phones) — no hover preview. Never navigates away — reuse the surrounding
 * thumbnail classes via `className` so layouts are unchanged.
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
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`relative block cursor-zoom-in rounded-md text-left ${className ?? ""}`}
        onClick={() => setOpen(true)}
        aria-label={alt ? `View ${alt} larger` : "View larger"}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? ""}
          className="pointer-events-none h-full w-full object-cover"
        />
      </button>

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
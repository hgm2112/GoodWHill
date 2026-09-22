"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";

/**
 * Browser barcode scanner (EAN-13 / UPC-A / Code128, etc.) for MTG sealed
 * product barcodes. Uses the back camera when available.
 */
export function BarcodeScanner({
  onDetected,
  onError,
  disabled,
}: {
  onDetected: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const busyRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
    };
  }, []);

  async function start() {
    setError(null);
    try {
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } } },
        videoRef.current!,
        (result) => {
          if (!result) return;
          if (busyRef.current) return;
          busyRef.current = true;
          const text = result.getText().trim();
          onDetected(text);
          // Brief lockout so one label doesn't fire twice, then re-enable.
          setTimeout(() => {
            busyRef.current = false;
          }, 1800);
        },
      );
      controlsRef.current = controls;
      setRunning(true);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not access the camera";
      setError(message);
      onError?.(message);
    }
  }

  return (
    <div className="card overflow-hidden p-0">
      <div className="relative aspect-[4/3] w-full bg-slate-900">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        {/* scan guide */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-24 w-3/5 rounded-lg border-2 border-white/70" />
          <div className="absolute top-2 left-2 text-xs text-white/60">
            {running ? "Align the barcode inside the frame" : "Camera off"}
          </div>
        </div>
      </div>

      {error && (
        <p className="border-b border-slate-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 p-3">
        {!running ? (
          <button
            type="button"
            className="btn btn-primary flex-1"
            onClick={start}
            disabled={disabled}
          >
            Start scanner
          </button>
        ) : (
          <button type="button" className="btn btn-secondary flex-1" onClick={stop}>
            Stop scanner
          </button>
        )}
        <p className="text-xs text-slate-500">
          Works on phone or laptop camera. Sealed product barcodes only.
        </p>
      </div>
    </div>
  );
}
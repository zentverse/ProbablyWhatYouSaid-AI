"use client";

import { useEffect, useRef, useState } from "react";
import {
  convertVideoToMp3,
  isSupportedVideoFile,
  type ConvertedMp3Result,
} from "@/lib/videoToMp3";

type ItemStatus = "pending" | "processing" | "done" | "error";

type ConversionItem = {
  id: string;
  file: File;
  status: ItemStatus;
  result?: ConvertedMp3Result;
  downloadUrl?: string;
  error?: string;
};

type VideoToMp3PanelProps = {
  onMp3Ready: (results: ConvertedMp3Result[]) => void;
};

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function newId(seed: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${seed}-${Math.random()}`;
}

export default function VideoToMp3Panel({ onMp3Ready }: VideoToMp3PanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<ConversionItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);

  const itemsRef = useRef<ConversionItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        if (item.downloadUrl) {
          URL.revokeObjectURL(item.downloadUrl);
        }
      }
    };
  }, []);

  const updateItem = (id: string, patch: Partial<ConversionItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const addAndConvert = async (fileList: FileList | File[]) => {
    const incoming: ConversionItem[] = Array.from(fileList).map((file) => {
      const supported = isSupportedVideoFile(file);
      return {
        id: newId(file.name),
        file,
        status: supported ? "pending" : "error",
        error: supported ? undefined : "Please upload an MP4 or MOV video file.",
      };
    });
    if (incoming.length === 0) return;

    setItems((prev) => [...prev, ...incoming]);
    setIsConverting(true);

    // ffmpeg.wasm is a single shared instance, so convert one at a time.
    for (const item of incoming) {
      if (item.status === "error") continue;
      updateItem(item.id, { status: "processing" });
      try {
        const result = await convertVideoToMp3(item.file);
        const url = URL.createObjectURL(result.blob);
        updateItem(item.id, { status: "done", result, downloadUrl: url });
      } catch (conversionError) {
        updateItem(item.id, {
          status: "error",
          error:
            conversionError instanceof Error
              ? conversionError.message
              : "The video could not be converted.",
        });
      }
    }

    setIsConverting(false);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      void addAndConvert(event.target.files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const clearAll = () => {
    for (const item of itemsRef.current) {
      if (item.downloadUrl) {
        URL.revokeObjectURL(item.downloadUrl);
      }
    }
    setItems([]);
  };

  const doneResults = items
    .filter((item) => item.status === "done" && item.result)
    .map((item) => item.result!);

  const statusLabel: Record<ItemStatus, string> = {
    pending: "Queued",
    processing: "Converting",
    done: "Done",
    error: "Failed",
  };

  return (
    <div className="rounded-[1.75rem] border border-white/10 bg-black/20 p-5 backdrop-blur-xl sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
            Convert
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">
            Video to MP3
          </h2>
        </div>
        <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-400">
          Browser-side
        </span>
      </div>

      <input
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov"
        multiple
        onChange={handleFileChange}
        className="hidden"
        ref={fileInputRef}
      />

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="mt-6 flex w-full flex-col gap-3 rounded-[1.5rem] border border-dashed border-white/15 bg-white/[0.03] px-5 py-6 text-left transition-all hover:border-white/30 hover:bg-white/[0.05]"
      >
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/6 text-slate-100">
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15.75 10.5V6.75a2.25 2.25 0 00-2.25-2.25h-6A2.25 2.25 0 005.25 6.75v10.5A2.25 2.25 0 007.5 19.5h9A2.25 2.25 0 0018.75 17.25v-6.75a2.25 2.25 0 00-2.25-2.25h-1.5a.75.75 0 01-.75-.75Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 3.75l3.75 3.75M9 12.75l2.25-1.5 2.25 1.5v3.75L11.25 15l-2.25 1.5v-3.75Z"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-medium text-white">
              {items.length
                ? `${items.length} video${items.length > 1 ? "s" : ""} selected`
                : "Choose video files"}
            </p>
            <p className="mt-1 text-sm text-slate-400">
              MP4 and MOV — pick one or many, converted in your browser
            </p>
          </div>
        </div>
      </button>

      {items.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
              Files
            </p>
            <button
              type="button"
              onClick={clearAll}
              disabled={isConverting}
              className="text-xs text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-50"
            >
              Clear all
            </button>
          </div>
          <div className="custom-scrollbar max-h-64 space-y-2 overflow-y-auto pr-1">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-100">
                    {item.file.name}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {formatFileSize(item.file.size)}
                    {item.error ? ` · ${item.error}` : ""}
                  </p>
                </div>
                {item.status === "done" && item.downloadUrl && item.result && (
                  <a
                    href={item.downloadUrl}
                    download={item.result.fileName}
                    className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-slate-200 transition-all hover:bg-white/[0.08]"
                  >
                    Download
                  </a>
                )}
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    item.status === "done"
                      ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
                      : item.status === "error"
                        ? "border-rose-300/25 bg-rose-400/10 text-rose-100"
                        : item.status === "processing"
                          ? "border-cyan-300/25 bg-cyan-400/10 text-cyan-50"
                          : "border-white/12 bg-white/[0.04] text-slate-300"
                  }`}
                >
                  {statusLabel[item.status]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 space-y-4">
        {isConverting && (
          <div className="rounded-2xl border border-cyan-300/20 bg-cyan-400/8 px-4 py-3 text-sm leading-7 text-cyan-50">
            Converting in the browser. Larger videos take a little longer, and
            files convert one at a time.
          </div>
        )}

        <button
          type="button"
          onClick={() => onMp3Ready(doneResults)}
          disabled={doneResults.length === 0 || isConverting}
          className="flex w-full items-center justify-center gap-3 rounded-full bg-white px-6 py-4 text-sm font-semibold text-slate-950 transition-all hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-slate-700"
        >
          {doneResults.length > 1
            ? `Send ${doneResults.length} MP3s to Transcribe`
            : "Send MP3 to Transcribe"}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import {
  convertVideoToMp3,
  ConvertedMp3Result,
  isSupportedVideoFile,
} from "@/lib/videoToMp3";

type ConversionStatus = "idle" | "processing" | "success" | "error";

type VideoToMp3PanelProps = {
  onMp3Ready: (result: ConvertedMp3Result) => void;
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

export default function VideoToMp3Panel({
  onMp3Ready,
}: VideoToMp3PanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ConversionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const resetState = () => {
    setFile(null);
    setStatus("idle");
    setError(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleVideoSelected = async (selectedFile: File) => {
    if (!isSupportedVideoFile(selectedFile)) {
      setFile(selectedFile);
      setStatus("error");
      setError("Please upload an MP4 or MOV video file.");
      return;
    }

    setFile(selectedFile);
    setStatus("processing");
    setError(null);

    try {
      const result = await convertVideoToMp3(selectedFile);
      setStatus("success");
      onMp3Ready(result);
    } catch (conversionError) {
      setStatus("error");
      setError(
        conversionError instanceof Error
          ? conversionError.message
          : "The video could not be converted."
      );
    }
  };

  const fileMeta = file
    ? `${formatFileSize(file.size)} - ${file.type || "video file"}`
    : "MP4 and MOV files are supported";

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
        onChange={(event) => {
          const selectedFile = event.target.files?.[0];
          if (selectedFile) {
            void handleVideoSelected(selectedFile);
          }
        }}
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
              {file ? file.name : "Choose a video file"}
            </p>
            <p className="mt-1 text-sm text-slate-400">{fileMeta}</p>
          </div>
        </div>
      </button>

      <div className="mt-6 space-y-4">
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-4">
          <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
            Flow
          </p>
          <p className="mt-3 text-sm leading-7 text-slate-300">
            Uploading an MP4 or MOV starts conversion automatically. The MP3 is
            created in your browser and then handed to the Transcribe tab as
            the selected audio file.
          </p>
        </div>

        {status === "processing" && (
          <div className="rounded-2xl border border-cyan-300/20 bg-cyan-400/8 px-4 py-3 text-sm leading-7 text-cyan-50">
            Loading the conversion engine and preparing the MP3. Larger videos
            may take a little longer.
          </div>
        )}

        {status === "error" && error && (
          <div className="rounded-2xl border border-rose-300/20 bg-rose-400/8 px-4 py-3 text-sm leading-7 text-rose-100">
            {error}
          </div>
        )}

        {(status === "idle" || status === "error") && (
          <button
            type="button"
            onClick={resetState}
            className="text-sm text-slate-400 transition-colors hover:text-slate-200"
          >
            Clear selection
          </button>
        )}
      </div>
    </div>
  );
}

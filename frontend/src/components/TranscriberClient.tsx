"use client";

import { useEffect, useRef, useState } from "react";
import VideoToMp3Panel from "@/components/VideoToMp3Panel";
import {
  convertVideoToMp3,
  isSupportedVideoFile,
  type ConvertedMp3Result,
} from "@/lib/videoToMp3";

type DiarizedSegment = {
  text: string;
  start?: number;
  end?: number;
  speaker?: string;
};

type TranscriptResponse = {
  text?: string;
  segments?: DiarizedSegment[];
  speakers?: { speaker: string; text: string }[];
  [key: string]: unknown;
};

type TranscriptionJobResponse = {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  message?: string;
  detail?: string;
  progress?: {
    completed_chunks?: number;
    total_chunks?: number | null;
  };
  result?: TranscriptResponse;
};

type WorkspaceMode = "transcribe" | "convert";

type JobStatus =
  | "pending"
  | "converting"
  | "ready"
  | "uploading"
  | "processing"
  | "done"
  | "error";

type BatchJob = {
  id: string;
  sourceFile: File;
  sourceName: string;
  isVideo: boolean;
  audioFile: File | null;
  audioFileName?: string;
  audioDownloadUrl?: string;
  status: JobStatus;
  statusMessage?: string;
  progress?: { completed: number; total: number | null };
  result?: TranscriptResponse;
  error?: string;
};

const BRAND_NAME = "Probably what you said AI";

const LANGUAGES = [
  { code: "", label: "Auto-detect" },
  { code: "Sinhala", label: "Sinhala" },
  { code: "English", label: "English" },
  { code: "Tamil", label: "Tamil" },
  { code: "Hindi", label: "Hindi" },
  { code: "Arabic", label: "Arabic" },
  { code: "Chinese", label: "Chinese" },
  { code: "Japanese", label: "Japanese" },
  { code: "Korean", label: "Korean" },
  { code: "French", label: "French" },
  { code: "German", label: "German" },
  { code: "Spanish", label: "Spanish" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "Russian", label: "Russian" },
  { code: "Swedish", label: "Swedish" },
];

const PROVIDERS = [
  {
    id: "speech",
    label: "Azure Speech",
    description: "Reliable first pick for Sinhala and Tamil audio.",
  },
  {
    id: "openai",
    label: "GPT-4o Transcribe",
    description: "Flexible language model pass for English-heavy recordings.",
  },
  {
    id: "google",
    label: "Google Speech-to-Text",
    description: "Useful third opinion when you want broader language coverage.",
  },
];

const LANGUAGE_TO_LOCALE: Record<string, string> = {
  Sinhala: "si-LK",
  English: "en-US",
  Tamil: "ta-IN",
  Hindi: "hi-IN",
  Arabic: "ar-SA",
  Chinese: "zh-CN",
  Japanese: "ja-JP",
  Korean: "ko-KR",
  French: "fr-FR",
  German: "de-DE",
  Spanish: "es-ES",
  Portuguese: "pt-BR",
  Russian: "ru-RU",
  Swedish: "sv-SE",
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8100";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_TRANSIENT_FAILURES = 4;
// How many files transcribe at once. The backend caps concurrent work, so a
// small pool keeps real parallelism without tripping its busy-queue limit.
const TRANSCRIBE_CONCURRENCY = 3;

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

function countWords(text: string, locale?: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    const segments = Array.from(segmenter.segment(normalized));
    const wordCount = segments.filter((segment) => segment.isWordLike).length;

    if (wordCount > 0) {
      return wordCount;
    }
  }

  return normalized.split(/\s+/).length;
}

function getErrorMessage(error: unknown, apiBaseUrl: string): string {
  const message =
    error instanceof Error ? error.message : "Transcription failed";

  const normalizedMessage = message.toLowerCase();
  if (
    normalizedMessage.includes("failed to fetch") ||
    normalizedMessage.includes("networkerror")
  ) {
    const frontendOrigin =
      typeof window !== "undefined" ? window.location.origin : "this app";

    return `Could not reach the transcription API at ${apiBaseUrl}. Make sure the backend is running and that it allows requests from ${frontendOrigin}.`;
  }

  return message;
}

function getFullText(result: TranscriptResponse): string {
  if (result.text) return result.text;
  if (result.segments) return result.segments.map((segment) => segment.text).join(" ");
  return JSON.stringify(result, null, 2);
}

function extractSpeakerSegments(
  result: TranscriptResponse
): { speaker: string; text: string }[] {
  if (result.segments && result.segments.length > 0) {
    const contentSegments = result.segments.filter(
      (seg) => seg.text.trim().length > 0
    );
    const diarizedSegments = contentSegments.filter(
      (seg) => typeof seg.speaker === "string" && seg.speaker.trim().length > 0
    );
    if (diarizedSegments.length !== contentSegments.length) {
      return [];
    }
    const grouped: { speaker: string; text: string }[] = [];
    for (const seg of diarizedSegments) {
      const speaker = seg.speaker!.trim();
      const lastGrp = grouped[grouped.length - 1];
      if (lastGrp && lastGrp.speaker === speaker) {
        lastGrp.text += " " + seg.text;
      } else {
        grouped.push({ speaker, text: seg.text });
      }
    }
    return grouped;
  }
  if (result.speakers && result.speakers.length > 0) return result.speakers;
  return [];
}

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "Queued",
  converting: "Converting",
  ready: "Ready",
  uploading: "Uploading",
  processing: "Transcribing",
  done: "Done",
  error: "Failed",
};

function statusChipClass(status: JobStatus): string {
  switch (status) {
    case "done":
      return "border-emerald-300/25 bg-emerald-400/10 text-emerald-100";
    case "error":
      return "border-rose-300/25 bg-rose-400/10 text-rose-100";
    case "converting":
    case "uploading":
    case "processing":
      return "border-cyan-300/25 bg-cyan-400/10 text-cyan-50";
    default:
      return "border-white/12 bg-white/[0.04] text-slate-300";
  }
}

// Run tasks with a bounded concurrency pool.
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    }
  );
  await Promise.all(runners);
}

export default function TranscriberClient() {
  const [mode, setMode] = useState<WorkspaceMode>("transcribe");
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [language, setLanguage] = useState("Sinhala");
  const [provider, setProvider] = useState("speech");
  const [englishOnly, setEnglishOnly] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep the latest jobs in a ref so async work reads current file references.
  const jobsRef = useRef<BatchJob[]>(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Revoke converted-MP3 object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const job of jobsRef.current) {
        if (job.audioDownloadUrl) {
          URL.revokeObjectURL(job.audioDownloadUrl);
        }
      }
    };
  }, []);

  const updateJob = (id: string, patch: Partial<BatchJob>) => {
    setJobs((prev) =>
      prev.map((job) => (job.id === id ? { ...job, ...patch } : job))
    );
  };

  const makeJob = (file: File): BatchJob => {
    const video = isSupportedVideoFile(file);
    return {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${file.name}-${file.size}-${Math.random()}`,
      sourceFile: file,
      sourceName: file.name,
      isVideo: video,
      audioFile: video ? null : file,
      status: video ? "pending" : "ready",
    };
  };

  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files).map(makeJob);
    if (incoming.length === 0) return;
    setError(null);
    setJobs((prev) => [...prev, ...incoming]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
    // Allow re-selecting the same files later.
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeJob = (id: string) => {
    setJobs((prev) => {
      const target = prev.find((job) => job.id === id);
      if (target?.audioDownloadUrl) {
        URL.revokeObjectURL(target.audioDownloadUrl);
      }
      return prev.filter((job) => job.id !== id);
    });
  };

  const clearJobs = () => {
    for (const job of jobsRef.current) {
      if (job.audioDownloadUrl) {
        URL.revokeObjectURL(job.audioDownloadUrl);
      }
    }
    setJobs([]);
    setError(null);
  };

  const handleConvertedAudioReady = (results: ConvertedMp3Result[]) => {
    if (results.length === 0) return;
    const audioJobs: BatchJob[] = results.map((res) => ({
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${res.fileName}-${Math.random()}`,
      sourceFile: res.file,
      sourceName: res.fileName,
      isVideo: false,
      audioFile: res.file,
      audioFileName: res.fileName,
      audioDownloadUrl: URL.createObjectURL(res.blob),
      status: "ready",
    }));
    setJobs((prev) => [...prev, ...audioJobs]);
    setError(null);
    setMode("transcribe");
  };

  const getProviderLabel = (providerId: string) =>
    PROVIDERS.find((item) => item.id === providerId)?.label || providerId;

  const pollTranscriptionJob = async (
    jobId: string,
    providerId: string,
    batchJobId: string
  ): Promise<TranscriptResponse> => {
    const providerLabel = getProviderLabel(providerId);
    let transientFailureCount = 0;

    for (;;) {
      let resp: Response;
      let data: TranscriptionJobResponse;

      try {
        resp = await fetch(`${API_BASE_URL}/transcribe/jobs/${jobId}`);
        data = await resp.json();
      } catch {
        transientFailureCount += 1;
        if (transientFailureCount >= MAX_POLL_TRANSIENT_FAILURES) {
          throw new Error(
            `Lost connection while checking ${providerLabel} transcription status.`
          );
        }
        updateJob(batchJobId, {
          statusMessage: `Reconnecting to ${providerLabel}...`,
        });
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      transientFailureCount = 0;

      if (!resp.ok) {
        throw new Error(data.detail || "Failed to fetch transcription job status");
      }

      const completedChunks = data.progress?.completed_chunks ?? 0;
      const totalChunks = data.progress?.total_chunks ?? null;

      if (data.status === "completed") {
        return data.result ?? { text: "", segments: [] };
      }
      if (data.status === "failed") {
        throw new Error(data.detail || `${providerLabel} transcription failed`);
      }

      updateJob(batchJobId, {
        status: "processing",
        statusMessage: totalChunks
          ? `Chunk ${Math.min(completedChunks + 1, totalChunks)} of ${totalChunks}`
          : data.message || "Preparing...",
        progress: { completed: completedChunks, total: totalChunks },
      });

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  const transcribeJob = async (job: BatchJob) => {
    if (!job.audioFile) {
      updateJob(job.id, { status: "error", error: "No audio to transcribe." });
      return;
    }
    updateJob(job.id, {
      status: "uploading",
      statusMessage: "Uploading...",
      error: undefined,
    });

    const formData = new FormData();
    formData.append("file", job.audioFile);
    formData.append("language", language);
    formData.append("provider", provider);
    formData.append("english_only", String(englishOnly));

    try {
      const resp = await fetch(`${API_BASE_URL}/transcribe`, {
        method: "POST",
        body: formData,
      });
      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        throw new Error(data?.detail || "Transcription failed");
      }

      if (resp.status === 202 && data?.job_id) {
        updateJob(job.id, {
          status: "processing",
          statusMessage: data.message || "Preparing...",
        });
        const result = await pollTranscriptionJob(data.job_id, provider, job.id);
        updateJob(job.id, {
          status: "done",
          result,
          statusMessage: undefined,
          progress: undefined,
        });
      } else {
        updateJob(job.id, {
          status: "done",
          result: data,
          statusMessage: undefined,
        });
      }
    } catch (err: unknown) {
      updateJob(job.id, {
        status: "error",
        error: getErrorMessage(err, API_BASE_URL),
        statusMessage: undefined,
      });
    }
  };

  const handleProcessAll = async () => {
    // Everything not already finished — includes failed jobs so a retry works.
    const pending = jobsRef.current.filter(
      (job) => job.status !== "done" || !job.result
    );
    if (pending.length === 0) return;

    setIsRunning(true);
    setError(null);

    // 1. Convert videos one at a time (ffmpeg.wasm is a single shared instance).
    for (const job of pending) {
      if (job.isVideo && !job.audioFile) {
        updateJob(job.id, {
          status: "converting",
          statusMessage: "Converting to MP3...",
          error: undefined,
        });
        try {
          const res = await convertVideoToMp3(job.sourceFile);
          job.audioFile = res.file;
          job.audioFileName = res.fileName;
          const url = URL.createObjectURL(res.blob);
          job.audioDownloadUrl = url;
          job.status = "ready";
          updateJob(job.id, {
            status: "ready",
            audioFile: res.file,
            audioFileName: res.fileName,
            audioDownloadUrl: url,
            statusMessage: undefined,
          });
        } catch (err: unknown) {
          job.status = "error";
          updateJob(job.id, {
            status: "error",
            error:
              err instanceof Error
                ? err.message
                : "The video could not be converted.",
            statusMessage: undefined,
          });
        }
      }
    }

    // 2. Transcribe everything that has audio, concurrently.
    const ready = pending.filter(
      (job) => job.audioFile && job.status !== "error"
    );
    await runPool(ready, TRANSCRIBE_CONCURRENCY, (job) => transcribeJob(job));

    setIsRunning(false);
  };

  const handleCopy = async (jobId: string, text: string) => {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedJobId(jobId);
      window.setTimeout(() => setCopiedJobId(null), 2000);
    } catch {
      setCopiedJobId(null);
    }
  };

  const isTranscribeMode = mode === "transcribe";
  const selectedProvider =
    PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  const selectedLanguage =
    LANGUAGES.find((item) => item.code === language)?.label ?? "Auto-detect";
  const openAiSinhalaWarning =
    provider === "openai" && language === "Sinhala"
      ? "GPT-4o can drift or repeat on long Sinhala recordings. Azure Speech is usually the safer primary result, with OpenAI best used as a second opinion."
      : null;

  const doneJobs = jobs.filter((job) => job.status === "done" && job.result);
  const pendingCount = jobs.filter(
    (job) => job.status !== "done" || !job.result
  ).length;
  const totalWords = doneJobs.reduce(
    (sum, job) =>
      sum + countWords(getFullText(job.result!), LANGUAGE_TO_LOCALE[language]),
    0
  );

  const heroTitle = isTranscribeMode
    ? "Cleaner transcripts, less interface noise."
    : "Turn video uploads into clean MP3 downloads.";
  const heroDescription = isTranscribeMode
    ? "Drop in one file or a whole batch of audio and video. Videos are converted to MP3 in the browser, then everything is transcribed together."
    : "Drop in one or many MP4/MOV files and the app converts each to MP3 in the browser, ready to download or hand straight to the Transcribe flow.";

  const heroStats = isTranscribeMode
    ? [
        { label: "Files", value: jobs.length ? String(jobs.length) : "0" },
        { label: "Engine", value: selectedProvider.label },
        {
          label: "Words",
          value: doneJobs.length ? totalWords.toLocaleString() : "0",
        },
      ]
    : [
        { label: "Input", value: "MP4 / MOV" },
        { label: "Output", value: "MP3" },
        { label: "Run", value: "In browser" },
      ];

  const processLabel = isRunning
    ? "Processing..."
    : jobs.length > 1
      ? `Transcribe ${pendingCount || jobs.length} files`
      : "Transcribe file";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
        <div className="flex flex-col justify-between gap-8">
          <div className="space-y-6">
            <div className="inline-flex w-fit rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.28em] text-slate-300">
              {BRAND_NAME}
            </div>

            <div className="space-y-4">
              <div className="inline-flex rounded-full border border-white/10 bg-white/[0.03] p-1">
                <button
                  type="button"
                  onClick={() => setMode("transcribe")}
                  className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.2em] transition-all ${
                    isTranscribeMode
                      ? "bg-white text-slate-950"
                      : "text-slate-400 hover:text-slate-100"
                  }`}
                >
                  Transcribe
                </button>
                <button
                  type="button"
                  onClick={() => setMode("convert")}
                  className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.2em] transition-all ${
                    !isTranscribeMode
                      ? "bg-white text-slate-950"
                      : "text-slate-400 hover:text-slate-100"
                  }`}
                >
                  Video to MP3
                </button>
              </div>
              <h1 className="max-w-2xl text-4xl font-semibold tracking-[-0.05em] text-white sm:text-5xl">
                {heroTitle}
              </h1>
              <p className="max-w-xl text-base leading-8 text-slate-400">
                {heroDescription}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {heroStats.map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-2xl border border-white/8 bg-white/4 px-4 py-4"
                >
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                    {stat.label}
                  </p>
                  <p className="mt-2 text-sm font-medium text-slate-100">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {isTranscribeMode && error && (
            <div className="rounded-2xl border border-rose-300/20 bg-rose-400/8 px-4 py-3 text-sm leading-7 text-rose-100">
              {error}
            </div>
          )}
        </div>

        {isTranscribeMode ? (
          <div className="rounded-[1.75rem] border border-white/10 bg-black/20 p-5 backdrop-blur-xl sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                  Upload
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">
                  Start transcripts
                </h2>
              </div>
              <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-400">
                {API_BASE_URL.replace(/^https?:\/\//, "")}
              </span>
            </div>

            <input
              type="file"
              accept="audio/*,video/mp4,video/quicktime,.mp4,.mov,.mp3,.wav,.m4a,.ogg,.flac"
              multiple
              onChange={handleFileChange}
              className="hidden"
              ref={fileInputRef}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isRunning}
              className="mt-6 flex w-full flex-col gap-3 rounded-[1.5rem] border border-dashed border-white/15 bg-white/[0.03] px-5 py-6 text-left transition-all hover:border-white/30 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
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
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-white">
                    {jobs.length
                      ? `${jobs.length} file${jobs.length > 1 ? "s" : ""} selected`
                      : "Choose audio or video files"}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Audio (MP3, WAV, M4A...) and video (MP4, MOV) — pick one or many
                  </p>
                </div>
              </div>
            </button>

            {jobs.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between px-1">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                    Queue
                  </p>
                  <button
                    type="button"
                    onClick={clearJobs}
                    disabled={isRunning}
                    className="text-xs text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-50"
                  >
                    Clear all
                  </button>
                </div>
                <div className="custom-scrollbar max-h-64 space-y-2 overflow-y-auto pr-1">
                  {jobs.map((job) => (
                    <div
                      key={job.id}
                      className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2.5"
                    >
                      <span className="text-[11px] text-slate-500">
                        {job.isVideo ? "VID" : "AUD"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-slate-100">
                          {job.sourceName}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {formatFileSize(job.sourceFile.size)}
                          {job.statusMessage ? ` · ${job.statusMessage}` : ""}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusChipClass(
                          job.status
                        )}`}
                      >
                        {STATUS_LABELS[job.status]}
                      </span>
                      {!isRunning && (
                        <button
                          type="button"
                          onClick={() => removeJob(job.id)}
                          aria-label={`Remove ${job.sourceName}`}
                          className="shrink-0 text-slate-500 transition-colors hover:text-rose-200"
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.7}
                              d="M6 18 18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 space-y-4">
              <div>
                <label className="mb-2 block text-[11px] uppercase tracking-[0.24em] text-slate-500">
                  Engine
                </label>
                <div className="space-y-2">
                  {PROVIDERS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setProvider(item.id)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition-all ${
                        provider === item.id
                          ? "border-white/20 bg-white/[0.07]"
                          : "border-white/8 bg-white/[0.02] hover:border-white/15"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-white">
                            {item.label}
                          </p>
                          <p className="mt-1 text-sm text-slate-400">
                            {item.description}
                          </p>
                        </div>
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${
                            provider === item.id ? "bg-cyan-300" : "bg-slate-600"
                          }`}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="language"
                  className="mb-2 block text-[11px] uppercase tracking-[0.24em] text-slate-500"
                >
                  Language
                </label>
                <select
                  id="language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-100 outline-none transition-all focus:border-white/20 focus:bg-white/[0.05]"
                >
                  {LANGUAGES.map((lang) => (
                    <option
                      key={lang.code}
                      value={lang.code}
                      className="bg-slate-950 text-slate-100"
                    >
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>

              <label
                htmlFor="english-only"
                className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 transition-all hover:border-white/20"
              >
                <input
                  id="english-only"
                  type="checkbox"
                  checked={englishOnly}
                  onChange={(e) => setEnglishOnly(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-300"
                />
                <span className="text-sm leading-6 text-slate-200">
                  English only
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500">
                    Keep only the passages spoken in English and drop the rest.
                    Applies to every file in the batch.
                  </span>
                </span>
              </label>

              {openAiSinhalaWarning && (
                <div className="rounded-2xl border border-amber-300/15 bg-amber-300/8 px-4 py-3 text-sm leading-7 text-amber-50">
                  {openAiSinhalaWarning}
                </div>
              )}

              <button
                type="button"
                onClick={handleProcessAll}
                disabled={jobs.length === 0 || isRunning || pendingCount === 0}
                className="flex w-full items-center justify-center gap-3 rounded-full bg-white px-6 py-4 text-sm font-semibold text-slate-950 transition-all hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-slate-700"
              >
                {isRunning ? (
                  <>
                    <svg
                      className="h-4 w-4 animate-spin"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    <span>{processLabel}</span>
                  </>
                ) : (
                  <span>{processLabel}</span>
                )}
              </button>
            </div>
          </div>
        ) : (
          <VideoToMp3Panel onMp3Ready={handleConvertedAudioReady} />
        )}
      </section>

      {isTranscribeMode && doneJobs.length > 0 && (
        <section className="mt-8 space-y-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                Results
              </p>
              <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">
                {doneJobs.length} transcript{doneJobs.length > 1 ? "s" : ""}
              </h3>
            </div>
            <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-400">
              {totalWords.toLocaleString()} words total
            </span>
          </div>

          <div className="space-y-5">
            {doneJobs.map((job) => (
              <ResultCard
                key={job.id}
                job={job}
                languageLocale={LANGUAGE_TO_LOCALE[language]}
                copied={copiedJobId === job.id}
                onCopy={handleCopy}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ResultCard({
  job,
  languageLocale,
  copied,
  onCopy,
}: {
  job: BatchJob;
  languageLocale?: string;
  copied: boolean;
  onCopy: (jobId: string, text: string) => void;
}) {
  const [view, setView] = useState<"full" | "speakers">("full");
  const result = job.result!;
  const fullText = getFullText(result);
  const speakerSegments = extractSpeakerSegments(result);
  const words = countWords(fullText, languageLocale);
  const hasSpeakers = speakerSegments.length > 0;

  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/18 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-white">
            {job.sourceName}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {words.toLocaleString()} words
            {job.isVideo ? " · converted from video" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasSpeakers && (
            <div className="inline-flex rounded-full border border-white/10 bg-white/[0.03] p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setView("full")}
                className={`rounded-full px-3 py-1 transition-all ${
                  view === "full" ? "bg-white text-slate-950" : "text-slate-400"
                }`}
              >
                Full
              </button>
              <button
                type="button"
                onClick={() => setView("speakers")}
                className={`rounded-full px-3 py-1 transition-all ${
                  view === "speakers"
                    ? "bg-white text-slate-950"
                    : "text-slate-400"
                }`}
              >
                Speakers
              </button>
            </div>
          )}
          {job.audioDownloadUrl && job.audioFileName && (
            <a
              href={job.audioDownloadUrl}
              download={job.audioFileName}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300 transition-all hover:bg-white/[0.08]"
            >
              MP3
            </a>
          )}
          <button
            type="button"
            onClick={() => onCopy(job.id, fullText)}
            aria-label="Copy transcript to clipboard"
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
              copied
                ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
                : "border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.08]"
            }`}
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.7}
                d="M9 12.75 11.25 15 15 9.75M9 3.75H7.5A2.25 2.25 0 0 0 5.25 6v12A2.25 2.25 0 0 0 7.5 20.25h9A2.25 2.25 0 0 0 18.75 18V6A2.25 2.25 0 0 0 16.5 3.75H15M9 3.75A2.25 2.25 0 0 1 11.25 1.5h1.5A2.25 2.25 0 0 1 15 3.75M9 3.75A2.25 2.25 0 0 0 11.25 6h1.5A2.25 2.25 0 0 0 15 3.75"
              />
            </svg>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="custom-scrollbar max-h-[460px] overflow-y-auto px-5 py-5 sm:px-6">
        {view === "speakers" && hasSpeakers ? (
          <div className="space-y-3">
            {speakerSegments.map((seg, idx) => (
              <div key={idx} className="rounded-[1.2rem] border border-white/10 bg-white/5 px-4 py-3">
                <span className="mb-2 inline-flex w-fit rounded-full border border-cyan-300/25 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.24em] text-cyan-100">
                  {seg.speaker}
                </span>
                <p className="text-sm leading-7 text-slate-200">{seg.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-[15px] leading-8 text-slate-200">
            {fullText}
          </p>
        )}
      </div>
    </div>
  );
}

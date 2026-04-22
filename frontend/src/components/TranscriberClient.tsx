"use client";

import { useEffect, useRef, useState } from "react";
import VideoToMp3Panel from "@/components/VideoToMp3Panel";
import type { ConvertedMp3Result } from "@/lib/videoToMp3";

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

type ConvertedAudioState = {
  downloadUrl: string;
  fileName: string;
  sourceVideoName: string;
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

export default function TranscriberClient() {
  const [mode, setMode] = useState<WorkspaceMode>("transcribe");
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("Sinhala");
  const [provider, setProvider] = useState("speech");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TranscriptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">(
    "idle"
  );
  const [convertedAudio, setConvertedAudio] = useState<ConvertedAudioState | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!convertedAudio) {
      return;
    }

    return () => {
      URL.revokeObjectURL(convertedAudio.downloadUrl);
    };
  }, [convertedAudio]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setResult(null);
      setError(null);
      setStatusMessage(null);
      setCopyStatus("idle");
      setConvertedAudio(null);
    }
  };

  const handleConvertedAudioReady = (convertedResult: ConvertedMp3Result) => {
    setFile(convertedResult.file);
    setResult(null);
    setError(null);
    setLoading(false);
    setCopyStatus("idle");
    setConvertedAudio({
      downloadUrl: URL.createObjectURL(convertedResult.blob),
      fileName: convertedResult.fileName,
      sourceVideoName: convertedResult.sourceVideoName,
    });
    setStatusMessage(
      `Converted ${convertedResult.sourceVideoName} to ${convertedResult.fileName}. Ready to transcribe.`
    );
    setMode("transcribe");
  };

  const getProviderLabel = (providerId: string) =>
    PROVIDERS.find((item) => item.id === providerId)?.label || providerId;

  const openAiSinhalaWarning =
    provider === "openai" && language === "Sinhala"
      ? "GPT-4o can drift or repeat on long Sinhala recordings. Azure Speech is usually the safer primary result, with OpenAI best used as a second opinion."
      : null;

  const pollTranscriptionJob = async (
    jobId: string,
    providerId: string
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

        setStatusMessage(
          `Reconnecting to ${providerLabel} transcription status...`
        );
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
        setStatusMessage(data.message || `${providerLabel} transcription complete.`);
        return data.result ?? { text: "", segments: [] };
      }

      if (data.status === "failed") {
        throw new Error(data.detail || `${providerLabel} transcription failed`);
      }

      if (totalChunks) {
        const nextChunk = Math.min(completedChunks + 1, totalChunks);
        setStatusMessage(
          data.message ||
            `${providerLabel} transcription processing chunk ${nextChunk} of ${totalChunks}...`
        );
      } else {
        setStatusMessage(data.message || `Preparing ${providerLabel} transcription...`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  const handleTranscribe = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setStatusMessage("Uploading audio...");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("language", language);
    formData.append("provider", provider);
    const providerLabel = getProviderLabel(provider);

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
        setStatusMessage(data.message || `Preparing ${providerLabel} transcription...`);
        const finalResult = await pollTranscriptionJob(data.job_id, provider);
        setResult(finalResult);
      } else {
        setStatusMessage(`${providerLabel} transcription complete.`);
        setResult(data);
        setCopyStatus("idle");
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, API_BASE_URL));
    } finally {
      setLoading(false);
      setStatusMessage(null);
    }
  };

  const handleCopyTranscript = async () => {
    if (!fullText.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(fullText);
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    }

    window.setTimeout(() => {
      setCopyStatus("idle");
    }, 2000);
  };

  const extractSpeakerSegments = (): { speaker: string; text: string }[] => {
    if (!result) return [];
    if (result.segments && result.segments.length > 0) {
      const contentSegments = result.segments.filter(
        (seg) => seg.text.trim().length > 0
      );

      const diarizedSegments = contentSegments.filter(
        (seg) =>
          typeof seg.speaker === "string" &&
          seg.speaker.trim().length > 0
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
  };

  const getFullText = (): string => {
    if (!result) return "";
    if (result.text) return result.text;
    if (result.segments) return result.segments.map((segment) => segment.text).join(" ");
    return JSON.stringify(result, null, 2);
  };

  const speakerSegments = extractSpeakerSegments();
  const fullText = getFullText();
  const selectedProvider =
    PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  const selectedLanguage =
    LANGUAGES.find((item) => item.code === language)?.label ?? "Auto-detect";
  const transcriptWordCount = countWords(
    fullText,
    LANGUAGE_TO_LOCALE[language]
  );
  const segmentCount = speakerSegments.length;
  const isTranscribeMode = mode === "transcribe";
  const convertedAudioIsSelected =
    !!file &&
    !!convertedAudio &&
    file.name === convertedAudio.fileName &&
    file.type === "audio/mpeg";
  const heroTitle = isTranscribeMode
    ? "Cleaner transcripts, less interface noise."
    : "Turn video uploads into clean MP3 downloads.";
  const heroDescription = isTranscribeMode
    ? "Upload a recording, choose the engine, and read the output in a layout that stays out of the way."
    : "Drop in an MP4 or MOV file and the app will convert it to MP3 in the browser, then pass that MP3 into the transcription flow.";

  const speakerStyles: Record<
    string,
    { align: string; badge: string; panel: string }
  > = {};
  const speakerPalette = [
    {
      align: "items-start",
      badge: "border-cyan-300/25 text-cyan-100",
      panel: "border-white/10 bg-white/5",
    },
    {
      align: "items-end",
      badge: "border-amber-300/25 text-amber-100",
      panel: "border-white/10 bg-white/5",
    },
    {
      align: "items-start",
      badge: "border-emerald-300/25 text-emerald-100",
      panel: "border-white/10 bg-white/5",
    },
    {
      align: "items-end",
      badge: "border-white/15 text-slate-100",
      panel: "border-white/10 bg-white/5",
    },
  ];
  let paletteIndex = 0;
  speakerSegments.forEach((segment) => {
    if (!speakerStyles[segment.speaker]) {
      speakerStyles[segment.speaker] =
        speakerPalette[paletteIndex % speakerPalette.length];
      paletteIndex += 1;
    }
  });

  const heroStats = isTranscribeMode
    ? [
        {
          label: "Engine",
          value: selectedProvider.label,
        },
        {
          label: "Language",
          value: selectedLanguage,
        },
        {
          label: "Words",
          value: result
            ? transcriptWordCount.toLocaleString()
            : file
              ? "Pending"
              : "0",
        },
      ]
    : [
        {
          label: "Input",
          value: "MP4 / MOV",
        },
        {
          label: "Output",
          value: "MP3",
        },
        {
          label: "Run",
          value: "In browser",
        },
      ];

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

          {isTranscribeMode && (statusMessage || error) && (
            <div
              className={`rounded-2xl border px-4 py-3 text-sm leading-7 ${
                error
                  ? "border-rose-300/20 bg-rose-400/8 text-rose-100"
                  : "border-cyan-300/20 bg-cyan-400/8 text-cyan-50"
              }`}
            >
              {error || statusMessage}
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
                  Start a new transcript
                </h2>
              </div>
              <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-400">
                {API_BASE_URL.replace(/^https?:\/\//, "")}
              </span>
            </div>

            <input
              type="file"
              accept="audio/*"
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
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-white">
                    {file ? file.name : "Choose an audio file"}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    {file
                      ? `${formatFileSize(file.size)} selected`
                      : "MP3, WAV, M4A, and similar formats"}
                  </p>
                </div>
              </div>
            </button>

            {convertedAudioIsSelected && convertedAudio && (
              <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-400/8 px-4 py-4 text-sm leading-7 text-emerald-50">
                <p>
                  Converted from {convertedAudio.sourceVideoName}. This MP3 is
                  now selected and ready for transcription.
                </p>
                <a
                  href={convertedAudio.downloadUrl}
                  download={convertedAudio.fileName}
                  className="mt-3 inline-flex text-sm font-medium text-white underline underline-offset-4 transition-opacity hover:opacity-80"
                >
                  Download converted MP3
                </a>
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

              {openAiSinhalaWarning && (
                <div className="rounded-2xl border border-amber-300/15 bg-amber-300/8 px-4 py-3 text-sm leading-7 text-amber-50">
                  {openAiSinhalaWarning}
                </div>
              )}

              <button
                type="button"
                onClick={handleTranscribe}
                disabled={!file || loading}
                className="flex w-full items-center justify-center gap-3 rounded-full bg-white px-6 py-4 text-sm font-semibold text-slate-950 transition-all hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-slate-700"
              >
                {loading ? (
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
                    <span>{statusMessage || "Transcribing..."}</span>
                  </>
                ) : (
                  <span>Transcribe with {selectedProvider.label}</span>
                )}
              </button>
            </div>
          </div>
        ) : (
          <VideoToMp3Panel onMp3Ready={handleConvertedAudioReady} />
        )}
      </section>

      {isTranscribeMode && result && (
        <section className="mt-8 grid gap-5 xl:grid-cols-[0.92fr_1.08fr]">
          <div className="flex h-[700px] flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/18 backdrop-blur-xl">
            <div className="border-b border-white/10 px-6 py-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                    View
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">
                    Speaker groups
                  </h3>
                </div>
                <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-400">
                  {segmentCount} blocks
                </span>
              </div>
            </div>

            <div className="custom-scrollbar flex-1 overflow-y-auto px-6 py-6">
              {speakerSegments.length > 0 ? (
                <div className="space-y-4">
                  {speakerSegments.map((seg, idx) => {
                    const styles = speakerStyles[seg.speaker] || speakerPalette[0];
                    const isLeft = styles.align === "items-start";

                    return (
                      <div key={idx} className={`flex flex-col ${styles.align}`}>
                        <span
                          className={`mb-2 w-fit rounded-full border px-3 py-1 text-[10px] font-medium uppercase tracking-[0.24em] ${styles.badge}`}
                        >
                          {seg.speaker}
                        </span>
                        <div
                          className={`max-w-[88%] rounded-[1.4rem] border px-4 py-4 text-sm leading-7 text-slate-200 ${styles.panel} ${
                            isLeft ? "rounded-tl-sm" : "rounded-tr-sm"
                          }`}
                        >
                          {seg.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-center">
                  <div className="max-w-sm space-y-3">
                    <p className="text-lg font-medium text-white">
                      Transcript completed
                    </p>
                    <p className="text-sm leading-6 text-slate-400">
                      This run did not include speaker-separated chunks, so the
                      full transcript on the right is the clearest view.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex h-[700px] flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/18 backdrop-blur-xl">
            <div className="border-b border-white/10 px-6 py-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                    Output
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">
                    Full transcript
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyTranscript}
                    aria-label="Copy transcript to clipboard"
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                      copyStatus === "success"
                        ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
                        : copyStatus === "error"
                          ? "border-rose-300/20 bg-rose-400/10 text-rose-100"
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
                    {copyStatus === "success"
                      ? "Copied transcript"
                      : copyStatus === "error"
                        ? "Retry copy"
                        : "Copy transcript"}
                  </button>
                  <span className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-400">
                    {transcriptWordCount.toLocaleString()} words
                  </span>
                </div>
              </div>
            </div>

            <div className="custom-scrollbar flex-1 overflow-y-auto px-6 py-6">
              <p className="whitespace-pre-wrap text-[15px] leading-8 text-slate-200">
                {fullText}
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

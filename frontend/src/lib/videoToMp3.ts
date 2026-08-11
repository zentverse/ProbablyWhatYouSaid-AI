import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".mov"];
const SUPPORTED_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
const FFMPEG_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
const BROWSER_CONVERSION_MAX_BYTES = 512 * 1024 * 1024;

export type ConvertedMp3Result = {
  blob: Blob;
  file: File;
  fileName: string;
  sourceVideoName: string;
};

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

const buildMp3FileName = (fileName: string) =>
  fileName.replace(/\.[^.]+$/, "") + ".mp3";

const buildConvertedResult = (file: File, blob: Blob): ConvertedMp3Result => {
  const fileName = buildMp3FileName(file.name);
  return {
    blob,
    file: new File([blob], fileName, { type: "audio/mpeg" }),
    fileName,
    sourceVideoName: file.name,
  };
};

const getErrorDetail = (error: unknown) =>
  error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Unknown conversion error";

function getInputExtension(file: File) {
  const extension = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  return extension || "mp4";
}

async function loadFfmpeg() {
  if (ffmpegInstance) {
    return ffmpegInstance;
  }

  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const ffmpeg = new FFmpeg();

      const coreURL = await toBlobURL(
        `${FFMPEG_BASE_URL}/ffmpeg-core.js`,
        "text/javascript"
      );
      const wasmURL = await toBlobURL(
        `${FFMPEG_BASE_URL}/ffmpeg-core.wasm`,
        "application/wasm"
      );

      await ffmpeg.load({ coreURL, wasmURL });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch((error) => {
      ffmpegLoadPromise = null;
      throw error;
    });
  }

  return ffmpegLoadPromise;
}

export function isSupportedVideoFile(file: File) {
  const normalizedName = file.name.toLowerCase();

  return (
    SUPPORTED_VIDEO_MIME_TYPES.includes(file.type) ||
    SUPPORTED_VIDEO_EXTENSIONS.some((extension) =>
      normalizedName.endsWith(extension)
    )
  );
}

export function shouldUseServerVideoConversion(file: File) {
  return file.size > BROWSER_CONVERSION_MAX_BYTES;
}

export async function convertVideoToMp3(
  file: File
): Promise<ConvertedMp3Result> {
  if (!isSupportedVideoFile(file)) {
    throw new Error("Please upload an MP4 or MOV video file.");
  }

  const ffmpeg = await loadFfmpeg().catch((error) => {
    throw new Error(
      `The browser could not load the video conversion engine: ${getErrorDetail(error)}`
    );
  });

  const inputName = `input-${crypto.randomUUID()}.${getInputExtension(file)}`;
  const outputName = `output-${crypto.randomUUID()}.mp3`;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Encode speech-optimized audio: 16 kHz mono at 64 kbps. Every transcription
    // provider downsamples to 16 kHz mono internally anyway, so this keeps full
    // transcription quality while producing a file ~3x smaller than 44.1 kHz
    // stereo — long recordings stay under the backend upload limit.
    await ffmpeg.exec([
      "-i",
      inputName,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "64k",
      outputName,
    ]);

    const outputData = await ffmpeg.readFile(outputName);

    if (typeof outputData === "string") {
      throw new Error("FFmpeg returned text instead of MP3 data.");
    }

    const outputBytes = outputData;
    const normalizedBytes = new Uint8Array(outputBytes.length);
    normalizedBytes.set(outputBytes);

    if (normalizedBytes.length === 0) {
      throw new Error("The selected video did not produce an MP3 output.");
    }

    const blob = new Blob([normalizedBytes.buffer], { type: "audio/mpeg" });
    return buildConvertedResult(file, blob);
  } catch (error) {
    throw new Error(
      `Browser video conversion failed: ${getErrorDetail(error)}`
    );
  } finally {
    await Promise.allSettled([
      ffmpeg.deleteFile(inputName),
      ffmpeg.deleteFile(outputName),
    ]);
  }
}

export async function convertVideoToMp3OnServer(
  file: File,
  apiBaseUrl: string
): Promise<ConvertedMp3Result> {
  if (!isSupportedVideoFile(file)) {
    throw new Error("Please upload an MP4 or MOV video file.");
  }

  const formData = new FormData();
  formData.append("file", file);
  const endpoint = `${apiBaseUrl.replace(/\/$/, "")}/convert/video-to-mp3`;

  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", body: formData });
  } catch (error) {
    throw new Error(
      `Could not reach the native video conversion service: ${getErrorDetail(error)}`
    );
  }

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as
      | { detail?: string }
      | null;
    throw new Error(
      data?.detail || `Native video conversion failed with HTTP ${response.status}.`
    );
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error("Native video conversion returned an empty MP3 file.");
  }
  return buildConvertedResult(file, blob);
}

export async function convertVideoToMp3Reliably(
  file: File,
  apiBaseUrl: string,
  onStatus?: (message: string) => void
): Promise<ConvertedMp3Result> {
  if (shouldUseServerVideoConversion(file)) {
    onStatus?.("Uploading large video for native conversion...");
    return convertVideoToMp3OnServer(file, apiBaseUrl);
  }

  onStatus?.("Converting to MP3 in the browser...");
  try {
    return await convertVideoToMp3(file);
  } catch {
    onStatus?.("Browser conversion failed; retrying natively...");
    return convertVideoToMp3OnServer(file, apiBaseUrl);
  }
}

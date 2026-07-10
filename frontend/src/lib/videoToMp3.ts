import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".mov"];
const SUPPORTED_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
const FFMPEG_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

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

export async function convertVideoToMp3(
  file: File
): Promise<ConvertedMp3Result> {
  if (!isSupportedVideoFile(file)) {
    throw new Error("Please upload an MP4 or MOV video file.");
  }

  const ffmpeg = await loadFfmpeg().catch((error) => {
    console.error("Failed to load FFmpeg:", error);
    throw new Error(
      "The browser could not load the video conversion engine. Refresh and try again."
    );
  });

  const inputName = `input-${crypto.randomUUID()}.${getInputExtension(file)}`;
  const outputFileName = buildMp3FileName(file.name);
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
    const mp3File = new File([blob], outputFileName, { type: "audio/mpeg" });

    return {
      blob,
      file: mp3File,
      fileName: outputFileName,
      sourceVideoName: file.name,
    };
  } catch (error) {
    console.error("Video conversion failed:", error);
    throw new Error(
      "This video could not be converted to MP3. The previous error came from the browser failing to decode the MOV file directly; this version uses FFmpeg, so if it still fails the file is likely damaged, encrypted, or missing an audio track."
    );
  } finally {
    await Promise.allSettled([
      ffmpeg.deleteFile(inputName),
      ffmpeg.deleteFile(outputName),
    ]);
  }
}

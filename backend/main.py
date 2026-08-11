import os
import tempfile
import asyncio
import time
import mimetypes
import json
import threading
import re
from collections import Counter
from uuid import uuid4
from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.background import BackgroundTask
import httpx
import imageio_ffmpeg
from dotenv import load_dotenv

try:
    from google.auth.exceptions import DefaultCredentialsError
    from google.cloud import speech as google_speech
except ImportError:
    DefaultCredentialsError = None
    google_speech = None

load_dotenv()

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
JOB_STORE_PATH = os.path.join(BACKEND_DIR, "transcription_jobs.json")
JOB_STORE_LOCK = threading.Lock()
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:3001,http://localhost:3001,http://127.0.0.1:3100,http://localhost:3100",
    ).split(",")
    if origin.strip()
]

app = FastAPI(
    title="Probably what you said AI",
    description=(
        "Multi-provider audio transcription API powered by Azure Speech, "
        "GPT-4o Transcribe, and Google Speech-to-Text."
    ),
)


def log_debug(message: str) -> None:
    """Keep debug logging from crashing on Windows cp1252 consoles."""
    safe_message = message.encode("ascii", errors="backslashreplace").decode("ascii")
    print(safe_message)


def _get_env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw_value = os.getenv(name, "").strip()
    if not raw_value:
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer.") from exc
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}.")
    return value


def _safe_remove_file(path: str | None) -> None:
    if path and os.path.exists(path):
        os.remove(path)


def _safe_remove_files(*paths: str | None) -> None:
    for path in paths:
        _safe_remove_file(path)


def _load_job_store() -> dict:
    if not os.path.exists(JOB_STORE_PATH):
        return {}
    with open(JOB_STORE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_job_store() -> None:
    temp_path = f"{JOB_STORE_PATH}.tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(TRANSCRIPTION_JOBS, f, ensure_ascii=True, indent=2)
    os.replace(temp_path, JOB_STORE_PATH)


def _initialize_job_store() -> None:
    global TRANSCRIPTION_JOBS
    with JOB_STORE_LOCK:
        TRANSCRIPTION_JOBS = _load_job_store()
        changed = False

        for job in TRANSCRIPTION_JOBS.values():
            if job.get("status") in {"queued", "processing"}:
                _safe_remove_file(job.get("temp_path"))
                job["status"] = "failed"
                job["message"] = _build_job_message(job.get("provider", "job"), "failed")
                job["detail"] = "Server restarted before the transcription job finished."
                job["temp_path"] = None
                job["updated_at"] = time.time()
                changed = True

        if changed:
            _save_job_store()


def _prune_old_jobs() -> None:
    cutoff = time.time() - TRANSCRIPTION_JOB_TTL_SECONDS
    with JOB_STORE_LOCK:
        stale_ids = [
            job_id
            for job_id, job in TRANSCRIPTION_JOBS.items()
            if job.get("updated_at", 0) < cutoff
        ]
        for job_id in stale_ids:
            _safe_remove_file(TRANSCRIPTION_JOBS[job_id].get("temp_path"))
            TRANSCRIPTION_JOBS.pop(job_id, None)
        if stale_ids:
            _save_job_store()


def _set_job_state(job_id: str, **updates) -> dict:
    with JOB_STORE_LOCK:
        job = TRANSCRIPTION_JOBS[job_id]
        job.update(updates)
        job["updated_at"] = time.time()
        _save_job_store()
        return dict(job)


def _serialize_job(job_id: str) -> dict:
    with JOB_STORE_LOCK:
        job = dict(TRANSCRIPTION_JOBS[job_id])
    payload = {
        "job_id": job_id,
        "status": job["status"],
        "provider": job["provider"],
        "message": job.get("message"),
        "progress": {
            "completed_chunks": job.get("completed_chunks", 0),
            "total_chunks": job.get("total_chunks"),
        },
    }
    if job["status"] == "completed":
        payload["result"] = job.get("result", {"text": "", "segments": []})
    if job["status"] == "failed":
        payload["detail"] = job.get("detail", "Transcription failed")
    return payload


def _provider_label(provider: str) -> str:
    return PROVIDER_LABELS.get(provider, provider.title())


def _build_job_message(
    provider: str,
    status: str,
    completed_chunks: int | None = None,
    total_chunks: int | None = None,
) -> str:
    label = _provider_label(provider)

    if status == "queued":
        return f"{label} transcription is running in the background."
    if status == "preparing":
        return f"Preparing {label} transcription..."
    if status == "completed":
        return f"{label} transcription complete."
    if status == "failed":
        return f"{label} transcription failed."
    if total_chunks is None:
        return f"Preparing {label} transcription..."
    if completed_chunks is not None and completed_chunks >= total_chunks:
        return f"Finalizing {label} transcription..."
    next_chunk = min((completed_chunks or 0) + 1, total_chunks)
    return f"{label} transcription processing chunk {next_chunk} of {total_chunks}..."


def _guess_audio_mime_type(filename: str) -> str:
    mime_type, _ = mimetypes.guess_type(filename)
    return mime_type or "application/octet-stream"


def _build_openai_prompt(lang: str, strict: bool = False) -> str:
    if lang:
        first_sentence = f"Transcribe the audio verbatim in {lang}."
    else:
        first_sentence = "Transcribe the audio verbatim in the original spoken language."

    prompt_parts = [
        first_sentence,
        "Do not translate, summarize, or explain.",
        "Keep names, numbers, and mixed-language phrases exactly as spoken.",
        "If any word or phrase is unclear, skip it instead of guessing.",
        "Do not invent content or repeat filler text.",
    ]

    if lang == "Sinhala":
        prompt_parts.append(
            "For Sinhala speech, return Sinhala words in Sinhala script and do not translate Sinhala speech into English."
        )
        prompt_parts.append(
            "Only keep English words in English when the speaker actually says them in English."
        )

    if strict and lang == "Sinhala":
        prompt_parts.append(
            "Important: if this chunk is mostly Sinhala speech, an English-heavy response is incorrect. Prefer leaving uncertain words blank over translating them."
        )

    return " ".join(prompt_parts)


def _collapse_repeated_tokens(tokens: list[str], max_repeat: int = 2) -> list[str]:
    if max_repeat < 1:
        return []

    collapsed = []
    last_token = None
    repeat_count = 0

    for token in tokens:
        if token == last_token:
            repeat_count += 1
        else:
            last_token = token
            repeat_count = 1

        if repeat_count <= max_repeat:
            collapsed.append(token)

    return collapsed


def _collapse_repeated_phrases(
    tokens: list[str],
    max_phrase_tokens: int = 12,
    min_repeats: int = 3,
) -> list[str]:
    if len(tokens) < min_repeats * 2:
        return tokens

    collapsed = []
    index = 0

    while index < len(tokens):
        best_match = None
        max_window = min(max_phrase_tokens, (len(tokens) - index) // min_repeats)

        for window_size in range(max_window, 1, -1):
            phrase = tokens[index:index + window_size]
            repeat_count = 1

            while index + (repeat_count + 1) * window_size <= len(tokens):
                start = index + repeat_count * window_size
                end = start + window_size
                if tokens[start:end] != phrase:
                    break
                repeat_count += 1

            if repeat_count >= min_repeats:
                best_match = (phrase, repeat_count, window_size)
                break

        if best_match:
            phrase, repeat_count, window_size = best_match
            collapsed.extend(phrase)
            index += repeat_count * window_size
            continue

        collapsed.append(tokens[index])
        index += 1

    return collapsed


def _collapse_repeated_sentences(text: str, max_cycle: int = 6) -> str:
    """Collapse immediately-repeating runs of sentences to a single copy.

    Handles not just one sentence looping (A A A) but multi-sentence cycles
    such as A B A B A B, which GPT-4o emits when it gets stuck on a chunk. For
    each position the longest-spanning repeat is collapsed, and the smallest
    period is kept so the run reduces to one fundamental copy.
    """
    parts = [
        part.strip()
        for part in re.split(r"(?<=[.!?])\s+|\n+", text)
        if part.strip()
    ]
    if len(parts) < 2:
        return text

    keys = [
        re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", part, flags=re.UNICODE)).strip().lower()
        for part in parts
    ]

    cleaned_parts = []
    n = len(parts)
    i = 0
    while i < n:
        best_cycle = 0
        best_span = 0
        best_end = i
        max_len = min(max_cycle, (n - i) // 2)
        for cycle in range(1, max_len + 1):
            block = keys[i:i + cycle]
            if "" in block:
                continue
            repeats = 1
            j = i + cycle
            while j + cycle <= n and keys[j:j + cycle] == block:
                repeats += 1
                j += cycle
            if repeats >= 2 and repeats * cycle > best_span:
                best_span = repeats * cycle
                best_cycle = cycle
                best_end = j

        if best_cycle:
            cleaned_parts.extend(parts[i:i + best_cycle])  # keep one copy
            i = best_end
        else:
            cleaned_parts.append(parts[i])
            i += 1

    if len(cleaned_parts) == len(parts):
        return text

    return " ".join(cleaned_parts).strip()


def _is_suspicious_repetition_token(token: str) -> bool:
    core = re.sub(r"^[^\w]+|[^\w]+$", "", token, flags=re.UNICODE)
    if len(core) < 24:
        return False

    # Keep obvious structured values such as URLs, emails, or IDs.
    if any(marker in core for marker in ("http", "@", "/", "\\")):
        return False
    if any(char.isdigit() for char in core):
        return False

    unique_ratio = len(set(core)) / len(core)
    trigrams = [core[i:i + 3] for i in range(len(core) - 2)]
    most_common_trigram = Counter(trigrams).most_common(1)[0][1] if trigrams else 0

    if len(core) >= 40:
        return True

    return unique_ratio < 0.45 or most_common_trigram >= max(4, len(trigrams) // 6)


# Instruction-like strings the transcription model sometimes echoes into its
# output instead of transcribing speech. They are never part of the audio, so
# they are stripped wherever they appear (in full or as individual sentences).
_TRANSCRIPTION_ARTIFACTS = [
    "there may be provided context on the content of the audio or conversation",
    "use this only as weak contextual guidance",
    "the audio itself is authoritative",
]
_TRANSCRIPTION_ARTIFACT_RE = re.compile(
    r"\s*(?:" + "|".join(re.escape(s) for s in _TRANSCRIPTION_ARTIFACTS) + r")\s*[.!?]*",
    re.IGNORECASE,
)


def _strip_transcription_artifacts(text: str) -> str:
    cleaned = _TRANSCRIPTION_ARTIFACT_RE.sub(" ", text)
    return re.sub(r"\s+", " ", cleaned).strip()


def _clean_openai_transcript_text(text: str) -> str:
    normalized = re.sub(r"\s+", " ", (text or "")).strip()
    normalized = _strip_transcription_artifacts(normalized)
    if not normalized:
        return ""

    tokens = normalized.split(" ")
    tokens = [token for token in tokens if not _is_suspicious_repetition_token(token)]
    tokens = _collapse_repeated_tokens(tokens, max_repeat=2)
    tokens = _collapse_repeated_phrases(tokens, max_phrase_tokens=24, min_repeats=3)

    cleaned = " ".join(tokens).strip()
    return _collapse_repeated_sentences(cleaned)


def _clean_openai_result(result: dict) -> dict:
    cleaned = dict(result)

    if isinstance(cleaned.get("text"), str):
        cleaned["text"] = _clean_openai_transcript_text(cleaned["text"])

    if isinstance(cleaned.get("segments"), list):
        cleaned_segments = []
        for segment in cleaned["segments"]:
            if not isinstance(segment, dict):
                continue

            cleaned_segment = dict(segment)
            cleaned_text = _clean_openai_transcript_text(str(cleaned_segment.get("text", "")))
            if not cleaned_text:
                continue

            cleaned_segment["text"] = cleaned_text
            cleaned_segments.append(cleaned_segment)

        cleaned["segments"] = cleaned_segments

        if not cleaned.get("text") and cleaned_segments:
            cleaned["text"] = " ".join(segment["text"] for segment in cleaned_segments).strip()

    return cleaned


def _extract_openai_result_text(result: dict) -> str:
    text = result.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()

    segments = result.get("segments")
    if isinstance(segments, list):
        parts = []
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            value = str(segment.get("text", "")).strip()
            if value:
                parts.append(value)
        return " ".join(parts).strip()

    return ""


def _count_script_characters(text: str) -> tuple[int, int]:
    sinhala_count = 0
    latin_count = 0

    for char in text:
        codepoint = ord(char)
        if 0x0D80 <= codepoint <= 0x0DFF:
            sinhala_count += 1
        elif char.isascii() and char.isalpha():
            latin_count += 1

    return sinhala_count, latin_count


# Splits a transcript into sentence-ish pieces so we can keep or drop each one
# by its dominant script. Handles English/Sinhala terminators and line breaks.
_SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?।])\s+|[\r\n]+")


def _text_is_predominantly_english(text: str) -> bool:
    """True when Latin letters outnumber Sinhala letters in the passage."""
    sinhala_count, latin_count = _count_script_characters(text)
    return latin_count > sinhala_count


# A compact set of high-frequency English words. Romanized Sinhala (and other
# transliterated non-English text) is written in Latin letters, so the script
# test above cannot catch it — but such text is almost devoid of these words,
# while any genuine English sentence is dense with them. The ratio therefore
# separates real English from romanized transliteration without a dictionary.
_COMMON_ENGLISH_WORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "so", "if", "of", "to", "in", "on",
    "at", "by", "for", "with", "from", "into", "about", "over", "under", "as",
    "than", "then", "this", "that", "these", "those", "it", "its", "we", "you",
    "they", "he", "she", "i", "me", "him", "her", "us", "them", "my", "your",
    "our", "their", "his", "who", "which", "what", "is", "are", "was", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "can", "could", "should", "may", "might", "must", "not", "no",
    "all", "any", "some", "more", "most", "other", "such", "there", "here",
    "when", "while", "because", "how", "also", "just", "only", "very", "like",
    "one", "two", "up", "out", "down", "after", "before", "between", "through",
    "get", "got", "make", "made", "go", "going", "went", "see", "use", "used",
    "called", "each", "many", "much", "well", "now", "usually", "thereafter",
})

# Below this many Latin words the ratio test is unreliable, so short fragments
# (proper-noun lists, brief phrases) are kept rather than risk dropping real
# English. Romanized Sinhala arrives in much longer runs, so it is still caught.
_ENGLISH_MIN_WORDS = 8
# Genuine English prose runs ~0.3-0.5 common-word density; romanized Sinhala is
# near zero. 0.18 sits well clear of real English while rejecting romanized runs
# that only clip the threshold via a single coincidental match ("Me" == "me").
_ENGLISH_MIN_RATIO = 0.18


def _looks_like_english(text: str) -> bool:
    """True when a Latin-script passage carries enough common English words.

    Distinguishes genuine English from romanized Sinhala, which the script test
    cannot — both are Latin, but only real English is dense with function words.
    """
    tokens = re.findall(r"[A-Za-z]+", text)
    if len(tokens) < _ENGLISH_MIN_WORDS:
        return True
    hits = sum(1 for token in tokens if token.lower() in _COMMON_ENGLISH_WORDS)
    return hits / len(tokens) >= _ENGLISH_MIN_RATIO


def _is_english_passage(text: str) -> bool:
    """Keep a passage only if it is Latin-script AND reads as real English."""
    return _text_is_predominantly_english(text) and _looks_like_english(text)


def _classify_english_piece(text: str) -> str:
    """Label a sentence piece as 'en' (English), 'no' (not), or 'weak'.

    'weak' is a short Latin fragment with too few common words to judge on its
    own — it could be an English proper-noun list ("Ethiopian Arabica, Brazilian
    Arabica") or a scrap of romanized speech ("Coffee espresso machine"). The
    caller decides those by surrounding context.
    """
    if not _text_is_predominantly_english(text):
        return "no"
    tokens = re.findall(r"[A-Za-z]+", text)
    if not tokens:
        return "no"
    ratio = sum(1 for token in tokens if token.lower() in _COMMON_ENGLISH_WORDS) / len(tokens)
    if ratio >= _ENGLISH_MIN_RATIO:
        return "en"
    if len(tokens) >= _ENGLISH_MIN_WORDS:
        return "no"  # long Latin run with almost no English words -> romanized
    return "weak"


def _english_only_text(text: str) -> str:
    """Keep only the sentence-level pieces that read as English.

    Confident English is always kept and clear non-English is always dropped.
    Short ambiguous fragments are kept only when isolated between English on
    both sides, so a lone proper-noun list survives but a run of choppy
    romanized fragments ("Coffee espresso machine. Vijesing espressoka. ...")
    is dropped as a block.
    """
    if not text or not text.strip():
        return ""
    pieces = [piece.strip() for piece in _SENTENCE_BOUNDARY_RE.split(text) if piece.strip()]
    if not pieces:
        return ""

    labels = [_classify_english_piece(piece) for piece in pieces]
    last = len(pieces) - 1
    kept = []
    for i, piece in enumerate(pieces):
        if labels[i] == "en":
            kept.append(piece)
        elif labels[i] == "weak":
            prev_en = i == 0 or labels[i - 1] == "en"
            next_en = i == last or labels[i + 1] == "en"
            if prev_en and next_en:
                kept.append(piece)
    return " ".join(kept).strip()


def _english_only_result(result: dict) -> dict:
    """Filter a {text, segments} result down to its English passages.

    Works for providers that return diarized segments (Azure, Google) and for
    GPT-4o Transcribe, which usually returns only a `text` blob with no
    segments. Whole segments that are dominated by Sinhala are dropped; kept
    segments are additionally trimmed to their English sentences.
    """
    if not isinstance(result, dict):
        return result

    filtered = dict(result)
    segments = result.get("segments") if isinstance(result.get("segments"), list) else []
    kept_segments = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        segment_text = str(segment.get("text", ""))
        if not _is_english_passage(segment_text):
            continue
        trimmed = _english_only_text(segment_text) or segment_text.strip()
        if not trimmed:
            continue
        english_segment = dict(segment)
        english_segment["text"] = trimmed
        kept_segments.append(english_segment)

    filtered["segments"] = kept_segments
    if kept_segments:
        filtered["text"] = " ".join(seg["text"] for seg in kept_segments).strip()
    else:
        # No usable segments (e.g. GPT-4o) — fall back to sentence filtering.
        filtered["text"] = _english_only_text(str(result.get("text", "")))

    return filtered


def _apply_english_only(result: dict, english_only: bool) -> dict:
    if not english_only:
        return result
    return _english_only_result(result)


def _is_openai_language_drift(result: dict, lang: str) -> bool:
    if lang != "Sinhala":
        return False

    text = _extract_openai_result_text(result)
    if not text:
        return False

    sinhala_count, latin_count = _count_script_characters(text)
    total_script_letters = sinhala_count + latin_count
    english_words = re.findall(r"\b[A-Za-z][A-Za-z'-]{2,}\b", text)

    if total_script_letters < 24:
        return latin_count >= 18 and latin_count > sinhala_count * 2

    if sinhala_count < 12 and len(english_words) >= 8:
        return True

    if latin_count >= 36 and latin_count > sinhala_count * 1.6:
        return True

    return False


async def _save_upload_to_temp(
    upload: UploadFile,
    *,
    max_size_bytes: int | None = None,
    max_size_mb: int | None = None,
) -> tuple[str, int]:
    suffix = os.path.splitext(upload.filename or "")[1] or ".bin"
    size = 0
    temp_path = None
    size_limit = max_size_bytes or MAX_UPLOAD_SIZE_BYTES
    size_limit_mb = max_size_mb or MAX_UPLOAD_SIZE_MB

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > size_limit:
                    raise HTTPException(
                        413,
                        f"Upload too large. Limit is {size_limit_mb} MB per file.",
                    )
                tmp.write(chunk)
    except Exception:
        _safe_remove_file(temp_path)
        raise
    finally:
        await upload.close()

    return temp_path, size


def _converted_mp3_filename(filename: str | None) -> str:
    source_name = os.path.basename(filename or "video")
    stem = os.path.splitext(source_name)[0].strip() or "video"
    return f"{stem}.mp3"


async def _convert_video_file_to_mp3(input_path: str, output_path: str) -> None:
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    process = await asyncio.create_subprocess_exec(
        ffmpeg_exe,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        input_path,
        "-map",
        "0:a:0",
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-b:a",
        "64k",
        output_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()

    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        if len(detail) > 800:
            detail = detail[-800:]
        raise HTTPException(
            422,
            "FFmpeg could not extract audio from this video. "
            + (detail or "The file may be damaged, encrypted, or missing an audio track."),
        )

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise HTTPException(422, "The video did not contain a usable audio track.")


def _count_active_background_jobs() -> int:
    with JOB_STORE_LOCK:
        return sum(
            1
            for job in TRANSCRIPTION_JOBS.values()
            if job.get("status") in {"queued", "processing"}
        )


async def _run_transcription_with_slot(runner_factory):
    async with TRANSCRIPTION_RUNNER_SLOTS:
        return await runner_factory()


def _enqueue_transcription_job(provider: str, temp_path: str, runner_factory):
    _prune_old_jobs()
    if _count_active_background_jobs() >= MAX_ACTIVE_BACKGROUND_JOBS:
        raise HTTPException(
            429,
            (
                "The server is already processing the maximum number of background "
                f"jobs ({MAX_ACTIVE_BACKGROUND_JOBS}). Try again shortly."
            ),
        )
    job_id = uuid4().hex
    with JOB_STORE_LOCK:
        TRANSCRIPTION_JOBS[job_id] = {
            "status": "queued",
            "provider": provider,
            "message": _build_job_message(provider, "queued"),
            "completed_chunks": 0,
            "total_chunks": None,
            "result": None,
            "detail": None,
            "temp_path": temp_path,
            "updated_at": time.time(),
        }
        _save_job_store()
    asyncio.create_task(_run_transcription_job(job_id, provider, runner_factory))
    return JSONResponse(status_code=202, content=_serialize_job(job_id))


async def _run_transcription_job(job_id: str, provider: str, runner_factory):
    with JOB_STORE_LOCK:
        temp_path = TRANSCRIPTION_JOBS.get(job_id, {}).get("temp_path")

    _set_job_state(
        job_id,
        status="processing",
        message=_build_job_message(provider, "preparing"),
        completed_chunks=0,
        total_chunks=None,
        detail=None,
    )

    def on_progress(completed_chunks: int, total_chunks: int) -> None:
        _set_job_state(
            job_id,
            status="processing",
            message=_build_job_message(provider, "processing", completed_chunks, total_chunks),
            completed_chunks=completed_chunks,
            total_chunks=total_chunks,
        )

    try:
        result = await _run_transcription_with_slot(lambda: runner_factory(on_progress))
        total_chunks = TRANSCRIPTION_JOBS[job_id].get("total_chunks") or 0
        _set_job_state(
            job_id,
            status="completed",
            message=_build_job_message(provider, "completed"),
            completed_chunks=total_chunks,
            result=result,
            temp_path=None,
        )
    except HTTPException as e:
        _set_job_state(
            job_id,
            status="failed",
            message=_build_job_message(provider, "failed"),
            detail=str(e.detail),
            temp_path=None,
        )
    except Exception as e:
        _set_job_state(
            job_id,
            status="failed",
            message=_build_job_message(provider, "failed"),
            detail=str(e),
            temp_path=None,
        )
    finally:
        _safe_remove_file(temp_path)

@app.middleware("http")
async def enforce_upload_limits(request: Request, call_next):
    upload_limits = {
        "/transcribe": (MAX_UPLOAD_SIZE_BYTES, MAX_UPLOAD_SIZE_MB),
        "/convert/video-to-mp3": (
            MAX_VIDEO_UPLOAD_SIZE_BYTES,
            MAX_VIDEO_UPLOAD_SIZE_MB,
        ),
    }
    upload_limit = upload_limits.get(request.url.path)

    if request.method == "POST" and upload_limit:
        max_size_bytes, max_size_mb = upload_limit
        content_type = request.headers.get("content-type", "")
        if "multipart/form-data" not in content_type.lower():
            return JSONResponse(
                status_code=415,
                content={"detail": "Upload requests must use multipart/form-data."},
            )

        content_length = request.headers.get("content-length")
        if not content_length:
            return JSONResponse(
                status_code=411,
                content={
                    "detail": (
                        "Content-Length is required for uploads and must stay within "
                        f"the {max_size_mb} MB file limit."
                    )
                },
            )

        try:
            declared_size = int(content_length)
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"detail": "Content-Length must be a valid integer."},
            )

        if declared_size <= 0:
            return JSONResponse(
                status_code=400,
                content={"detail": "Content-Length must be greater than zero."},
            )

        # Multipart boundaries and headers add a small amount beyond the file itself.
        if declared_size > max_size_bytes + MULTIPART_OVERHEAD_ALLOWANCE_BYTES:
            return JSONResponse(
                status_code=413,
                content={
                    "detail": f"Upload too large. Limit is {max_size_mb} MB per file."
                },
            )

    return await call_next(request)


# Register CORS after the upload guard so it remains the outer middleware and
# adds browser-readable headers even when the guard rejects a request early.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS
    or [
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:3001",
        "http://localhost:3001",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Azure Speech Services config ──
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION")

# ── GPT-4o Transcribe config ──
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT")
AZURE_OPENAI_KEY = os.getenv("AZURE_OPENAI_KEY")

# Language → Azure Speech locale mapping
LANGUAGE_TO_LOCALE = {
    "Sinhala": "si-LK",
    "English": "en-US",
    "Tamil": "ta-LK",
    "Hindi": "hi-IN",
    "Arabic": "ar-SA",
    "Chinese": "zh-CN",
    "Japanese": "ja-JP",
    "Korean": "ko-KR",
    "French": "fr-FR",
    "German": "de-DE",
    "Spanish": "es-ES",
    "Portuguese": "pt-BR",
    "Russian": "ru-RU",
    "Swedish": "sv-SE",
}

LANGUAGE_TO_GOOGLE_LOCALE = {
    "Sinhala": "si-LK",
    "English": "en-US",
    "Tamil": "ta-IN",
    "Hindi": "hi-IN",
    "Arabic": "ar-SA",
    "Chinese": "cmn-Hans-CN",
    "Japanese": "ja-JP",
    "Korean": "ko-KR",
    "French": "fr-FR",
    "German": "de-DE",
    "Spanish": "es-ES",
    "Portuguese": "pt-BR",
    "Russian": "ru-RU",
    "Swedish": "sv-SE",
}

GOOGLE_AUTO_DETECT_LOCALES = ["en-US", "si-LK", "ta-IN", "hi-IN"]
PROVIDER_LABELS = {
    "speech": "Azure Speech",
    "openai": "GPT-4o Transcribe",
    "google": "Google Speech-to-Text",
}

MAX_RETRIES = 3
RETRY_DELAY = 3
MAX_UPLOAD_SIZE_MB = _get_env_int("MAX_UPLOAD_SIZE_MB", 256)
MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024
MAX_VIDEO_UPLOAD_SIZE_MB = _get_env_int("MAX_VIDEO_UPLOAD_SIZE_MB", 8192)
MAX_VIDEO_UPLOAD_SIZE_BYTES = MAX_VIDEO_UPLOAD_SIZE_MB * 1024 * 1024
MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 1024 * 1024
MAX_CONCURRENT_TRANSCRIPTIONS = _get_env_int("MAX_CONCURRENT_TRANSCRIPTIONS", 2)
MAX_ACTIVE_BACKGROUND_JOBS = _get_env_int("MAX_ACTIVE_BACKGROUND_JOBS", 4)
SPEECH_CHUNK_SECONDS = 50  # Azure Speech REST limit ~60s
SPEECH_BACKGROUND_THRESHOLD_BYTES = 8 * 1024 * 1024
SPEECH_CHUNK_CONCURRENCY = 4
OPENAI_SINGLE_FILE_LIMIT_BYTES = 24 * 1024 * 1024
OPENAI_BACKGROUND_THRESHOLD_BYTES = 8 * 1024 * 1024
OPENAI_CHUNK_CONCURRENCY = 2
OPENAI_CHUNK_SECONDS = 90
GOOGLE_BACKGROUND_THRESHOLD_BYTES = 8 * 1024 * 1024
GOOGLE_CHUNK_CONCURRENCY = 4
TRANSCRIPTION_JOB_TTL_SECONDS = 60 * 60
TRANSCRIPTION_JOBS = {}
TRANSCRIPTION_RUNNER_SLOTS = asyncio.Semaphore(MAX_CONCURRENT_TRANSCRIPTIONS)

_initialize_job_store()


# ════════════════════════════════════════════════════════
#  Main endpoint – routes to the selected provider
# ════════════════════════════════════════════════════════

@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(default=""),
    provider: str = Form(default="speech"),   # "speech" | "openai" | "google"
    english_only: bool = Form(default=False),
):
    temp_path, file_size = await _save_upload_to_temp(file)
    lang = language.strip()
    mode = provider.strip().lower()

    log_debug(
        f"DEBUG - provider={mode}, file={file.filename}, size={file_size}, "
        f"lang={lang}, english_only={english_only}"
    )

    try:
        if mode == "openai":
            return await _route_openai(file.filename, temp_path, file_size, lang, english_only)
        if mode == "google":
            return await _route_google(file.filename, temp_path, file_size, lang, english_only)
        if mode == "speech":
            return await _route_speech(file.filename, temp_path, file_size, lang, english_only)
        raise HTTPException(400, f"Unsupported provider: {provider}")
    except Exception:
        _safe_remove_file(temp_path)
        raise


@app.post("/convert/video-to-mp3")
async def convert_video_to_mp3(file: UploadFile = File(...)):
    extension = os.path.splitext(file.filename or "")[1].lower()
    if extension not in {".mp4", ".mov"}:
        await file.close()
        raise HTTPException(415, "Only MP4 and MOV video files are supported.")

    input_path = None
    output_path = None
    try:
        input_path, file_size = await _save_upload_to_temp(
            file,
            max_size_bytes=MAX_VIDEO_UPLOAD_SIZE_BYTES,
            max_size_mb=MAX_VIDEO_UPLOAD_SIZE_MB,
        )
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as output_file:
            output_path = output_file.name

        log_debug(
            f"DEBUG - native video conversion file={file.filename}, size={file_size}"
        )
        await _convert_video_file_to_mp3(input_path, output_path)

        cleanup = BackgroundTask(_safe_remove_files, input_path, output_path)
        response = FileResponse(
            output_path,
            media_type="audio/mpeg",
            filename=_converted_mp3_filename(file.filename),
            background=cleanup,
        )
        input_path = None
        output_path = None
        return response
    finally:
        _safe_remove_files(input_path, output_path)


@app.get("/transcribe/jobs/{job_id}")
async def get_transcription_job(job_id: str):
    _prune_old_jobs()
    if job_id not in TRANSCRIPTION_JOBS:
        raise HTTPException(404, "Transcription job not found")
    return _serialize_job(job_id)


@app.get("/health")
async def health():
    credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    google_ready = google_speech is not None and (
        not credentials_path or os.path.exists(credentials_path)
    )
    return {
        "status": "ok",
        "providers": {
            "speech": bool(AZURE_SPEECH_KEY and AZURE_SPEECH_REGION),
            "openai": bool(AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY),
            "google": google_ready,
        },
    }


# ════════════════════════════════════════════════════════
#  Provider 1 – Azure Speech Services  (Sinhala ✓)
# ════════════════════════════════════════════════════════

async def _route_speech(
    filename: str, input_path: str, file_size: int, lang: str, english_only: bool = False
):
    if not AZURE_SPEECH_KEY or not AZURE_SPEECH_REGION:
        raise HTTPException(500, "Azure Speech credentials missing. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in .env")

    locale = LANGUAGE_TO_LOCALE.get(lang or "Sinhala", "si-LK")
    if file_size >= SPEECH_BACKGROUND_THRESHOLD_BYTES:
        return _enqueue_transcription_job(
            "speech",
            input_path,
            lambda progress_callback: _speech_process(
                filename,
                input_path,
                locale,
                progress_callback=progress_callback,
                concurrency=SPEECH_CHUNK_CONCURRENCY,
                english_only=english_only,
            ),
        )
    try:
        return await _run_transcription_with_slot(
            lambda: _speech_process(filename, input_path, locale, english_only=english_only)
        )
    finally:
        _safe_remove_file(input_path)


async def _speech_process(
    filename: str,
    input_path: str,
    locale: str,
    progress_callback=None,
    concurrency: int = 1,
    english_only: bool = False,
):
    """Split → 16 kHz WAV chunks → Azure Speech REST API."""
    out_dir = tempfile.mkdtemp()
    out_pattern = os.path.join(out_dir, "chunk_%04d.wav")

    try:
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        proc = await asyncio.create_subprocess_exec(
            ffmpeg_exe, "-i", input_path,
            "-f", "segment", "-segment_time", str(SPEECH_CHUNK_SECONDS),
            "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
            out_pattern,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(500, f"FFmpeg failed: {err.decode()[:500]}")

        chunks = sorted(f for f in os.listdir(out_dir) if f.startswith("chunk_"))
        log_debug(f"DEBUG - Speech: {len(chunks)} chunks x ~{SPEECH_CHUNK_SECONDS}s")

        total_chunks = len(chunks)
        if progress_callback:
            progress_callback(0, total_chunks)

        async def process_chunk(index: int, name: str):
            chunk_path = os.path.join(out_dir, name)
            with open(chunk_path, "rb") as f:
                data = f.read()
            log_debug(f"DEBUG - chunk {index+1}/{total_chunks} ({len(data)} bytes)")
            res = await _speech_recognise(data, locale)
            text = ""
            duration = SPEECH_CHUNK_SECONDS
            if res and res.get("DisplayText"):
                text = res["DisplayText"]
                duration = res.get("Duration", SPEECH_CHUNK_SECONDS * 1e7) / 1e7
            return index, text, duration

        if concurrency <= 1:
            results = []
            for i, name in enumerate(chunks):
                results.append(await process_chunk(i, name))
                if progress_callback:
                    progress_callback(i + 1, total_chunks)
        else:
            semaphore = asyncio.Semaphore(concurrency)

            async def sem_task(index: int, name: str):
                async with semaphore:
                    return await process_chunk(index, name)

            tasks = [asyncio.create_task(sem_task(i, name)) for i, name in enumerate(chunks)]
            results = []
            completed = 0

            for task in asyncio.as_completed(tasks):
                results.append(await task)
                completed += 1
                if progress_callback:
                    progress_callback(completed, total_chunks)

        all_text, all_segments = [], []
        offset = 0.0
        for index, text, duration in sorted(results, key=lambda item: item[0]):
            if text:
                all_text.append(text)
                all_segments.append(
                    {
                        "text": text,
                        "start": offset,
                        "end": offset + duration,
                        "speaker": f"Chunk {index+1}",
                    }
                )
            offset += SPEECH_CHUNK_SECONDS

        return _apply_english_only(
            {"text": " ".join(all_text), "segments": all_segments}, english_only
        )
    finally:
        for f in os.listdir(out_dir):
            os.remove(os.path.join(out_dir, f))
        os.rmdir(out_dir)


async def _speech_recognise(audio: bytes, locale: str):
    url = f"https://{AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1"
    headers = {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        "Accept": "application/json",
    }
    params = {"language": locale, "format": "detailed"}

    for attempt in range(MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=60) as c:
                r = await c.post(url, headers=headers, params=params, content=audio)
                r.raise_for_status()
                j = r.json()
                status = j.get("RecognitionStatus", "?")
                log_debug(f"DEBUG - Speech status: {status}")
                if status == "Success":
                    return j
                return None
        except httpx.HTTPStatusError as e:
            log_debug(f"DEBUG - Speech HTTP {e.response.status_code}: {e.response.text[:300]}")
            if e.response.status_code >= 500 and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY); continue
            raise HTTPException(e.response.status_code, e.response.text)
        except Exception as e:
            log_debug(f"DEBUG - Speech error: {e}")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY); continue
            raise HTTPException(500, str(e))
    raise HTTPException(500, "Speech retries exhausted")


async def _route_google(
    filename: str, input_path: str, file_size: int, lang: str, english_only: bool = False
):
    if google_speech is None:
        raise HTTPException(500, "Google Speech dependency missing. Install google-cloud-speech in the backend environment.")

    credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if credentials_path and not os.path.exists(credentials_path):
        raise HTTPException(500, f"Google credentials file not found: {credentials_path}")

    locale = LANGUAGE_TO_GOOGLE_LOCALE.get(lang, GOOGLE_AUTO_DETECT_LOCALES[0])
    alternative_locales = [] if lang else GOOGLE_AUTO_DETECT_LOCALES[1:]
    if file_size >= GOOGLE_BACKGROUND_THRESHOLD_BYTES:
        return _enqueue_transcription_job(
            "google",
            input_path,
            lambda progress_callback: _google_process(
                filename,
                input_path,
                locale,
                alternative_locales,
                progress_callback=progress_callback,
                concurrency=GOOGLE_CHUNK_CONCURRENCY,
                english_only=english_only,
            ),
        )
    try:
        return await _run_transcription_with_slot(
            lambda: _google_process(
                filename, input_path, locale, alternative_locales, english_only=english_only
            )
        )
    finally:
        _safe_remove_file(input_path)


async def _google_process(
    filename: str,
    input_path: str,
    locale: str,
    alternative_locales: list[str],
    progress_callback=None,
    concurrency: int = 1,
    english_only: bool = False,
):
    out_dir = tempfile.mkdtemp()
    out_pattern = os.path.join(out_dir, "chunk_%04d.wav")

    try:
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        proc = await asyncio.create_subprocess_exec(
            ffmpeg_exe, "-i", input_path,
            "-f", "segment", "-segment_time", str(SPEECH_CHUNK_SECONDS),
            "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
            out_pattern,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(500, f"FFmpeg failed: {err.decode()[:500]}")

        chunks = sorted(f for f in os.listdir(out_dir) if f.startswith("chunk_"))
        log_debug(f"DEBUG - Google: {len(chunks)} chunks x ~{SPEECH_CHUNK_SECONDS}s")

        total_chunks = len(chunks)
        if progress_callback:
            progress_callback(0, total_chunks)

        async def process_chunk(index: int, name: str):
            chunk_path = os.path.join(out_dir, name)
            with open(chunk_path, "rb") as f:
                data = f.read()
            log_debug(f"DEBUG - Google chunk {index+1}/{total_chunks} ({len(data)} bytes)")
            response = await _google_recognise(data, locale, alternative_locales)
            return index, _google_response_to_output(
                response,
                index * SPEECH_CHUNK_SECONDS,
                index + 1,
            )

        if concurrency <= 1:
            results = []
            for i, name in enumerate(chunks):
                results.append(await process_chunk(i, name))
                if progress_callback:
                    progress_callback(i + 1, total_chunks)
        else:
            semaphore = asyncio.Semaphore(concurrency)

            async def sem_task(index: int, name: str):
                async with semaphore:
                    return await process_chunk(index, name)

            tasks = [asyncio.create_task(sem_task(i, name)) for i, name in enumerate(chunks)]
            results = []
            completed = 0

            for task in asyncio.as_completed(tasks):
                results.append(await task)
                completed += 1
                if progress_callback:
                    progress_callback(completed, total_chunks)

        all_text, all_segments = [], []
        for _, (chunk_text, chunk_segments) in sorted(results, key=lambda item: item[0]):
            if chunk_text:
                all_text.append(chunk_text)
            all_segments.extend(chunk_segments)

        return _apply_english_only(
            {"text": " ".join(all_text).strip(), "segments": all_segments}, english_only
        )
    finally:
        for f in os.listdir(out_dir):
            os.remove(os.path.join(out_dir, f))
        os.rmdir(out_dir)


async def _google_recognise(audio: bytes, locale: str, alternative_locales: list[str]):
    for attempt in range(MAX_RETRIES):
        try:
            log_debug(f"DEBUG - Google attempt {attempt+1}/{MAX_RETRIES} locale={locale}")
            response = await asyncio.to_thread(
                _google_recognise_sync,
                audio,
                locale,
                alternative_locales,
            )
            log_debug(f"DEBUG - Google results: {len(response.results)}")
            return response
        except Exception as e:
            if DefaultCredentialsError is not None and isinstance(e, DefaultCredentialsError):
                raise HTTPException(
                    500,
                    "Google credentials missing. Set GOOGLE_APPLICATION_CREDENTIALS to a Google service account JSON file or configure Application Default Credentials.",
                ) from e
            log_debug(f"DEBUG - Google error: {e}")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY)
                continue
            raise HTTPException(500, f"Google Speech error: {e}") from e
    raise HTTPException(500, "Google retries exhausted")


def _google_recognise_sync(audio: bytes, locale: str, alternative_locales: list[str]):
    client = google_speech.SpeechClient()
    try:
        config_kwargs = {
            "encoding": google_speech.RecognitionConfig.AudioEncoding.LINEAR16,
            "sample_rate_hertz": 16000,
            "language_code": locale,
            "model": "default",
            "enable_word_time_offsets": True,
        }
        if alternative_locales:
            config_kwargs["alternative_language_codes"] = alternative_locales

        config = google_speech.RecognitionConfig(**config_kwargs)
        response = client.recognize(
            config=config,
            audio=google_speech.RecognitionAudio(content=audio),
        )
        return response
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()


def _google_response_to_output(response, chunk_offset: float, chunk_number: int):
    texts = []
    segments = []
    current_start = chunk_offset

    for result in response.results:
        if not result.alternatives:
            continue

        text = result.alternatives[0].transcript.strip()
        if not text:
            continue

        result_end = chunk_offset + _duration_to_seconds(result.result_end_time)
        end_time = max(current_start, result_end)

        texts.append(text)
        segments.append(
            {
                "text": text,
                "start": current_start,
                "end": end_time,
                "speaker": f"Chunk {chunk_number}",
            }
        )
        current_start = end_time

    return " ".join(texts).strip(), segments


def _duration_to_seconds(duration) -> float:
    if duration is None:
        return 0.0
    total_seconds = getattr(duration, "total_seconds", None)
    if callable(total_seconds):
        return float(total_seconds())

    seconds = getattr(duration, "seconds", 0)
    nanos = getattr(duration, "nanos", 0)
    return float(seconds) + (float(nanos) / 1_000_000_000)


# ════════════════════════════════════════════════════════
#  Provider 2 – Azure OpenAI  gpt-4o-transcribe
# ════════════════════════════════════════════════════════

async def _route_openai(
    filename: str, input_path: str, file_size: int, lang: str, english_only: bool = False
):
    if not AZURE_OPENAI_ENDPOINT or not AZURE_OPENAI_KEY:
        raise HTTPException(500, "Azure OpenAI credentials missing. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY in .env")

    if file_size >= OPENAI_BACKGROUND_THRESHOLD_BYTES:
        return _enqueue_transcription_job(
            "openai",
            input_path,
            lambda progress_callback: _openai_process(
                filename,
                input_path,
                file_size,
                lang,
                progress_callback=progress_callback,
                concurrency=OPENAI_CHUNK_CONCURRENCY,
                english_only=english_only,
            ),
        )
    try:
        return await _run_transcription_with_slot(
            lambda: _openai_process(filename, input_path, file_size, lang, english_only=english_only)
        )
    finally:
        _safe_remove_file(input_path)


async def _openai_process(
    filename: str,
    input_path: str,
    file_size: int,
    lang: str,
    progress_callback=None,
    concurrency: int = 1,
    english_only: bool = False,
):
    if file_size < OPENAI_SINGLE_FILE_LIMIT_BYTES:
        if progress_callback:
            progress_callback(0, 1)
        with open(input_path, "rb") as f:
            audio_data = f.read()
        result = await _openai_send(filename, audio_data, lang)
        if progress_callback:
            progress_callback(1, 1)
        return _apply_english_only(result, english_only)
    result = await _openai_large(
        filename,
        input_path,
        lang,
        progress_callback=progress_callback,
        concurrency=concurrency,
    )
    return _apply_english_only(result, english_only)


async def _openai_send(filename: str, audio_data: bytes, lang: str):
    headers = {"api-key": AZURE_OPENAI_KEY}
    mime_type = _guess_audio_mime_type(filename)

    for attempt in range(MAX_RETRIES):
        prompt = _build_openai_prompt(lang, strict=attempt > 0)
        async with httpx.AsyncClient(timeout=600) as c:
            files = {"file": (filename, audio_data, mime_type)}
            data = {"model": "gpt-4o-transcribe", "response_format": "json"}
            data["prompt"] = prompt

            try:
                log_debug(f"DEBUG - OpenAI attempt {attempt+1}/{MAX_RETRIES} for {filename}")
                r = await c.post(AZURE_OPENAI_ENDPOINT, headers=headers, files=files, data=data)
                r.raise_for_status()
                result = _clean_openai_result(r.json())
                if _is_openai_language_drift(result, lang):
                    log_debug(
                        f"DEBUG - OpenAI Sinhala guard retry for {filename}: English-heavy response detected"
                    )
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(RETRY_DELAY)
                        continue
                    log_debug(
                        f"DEBUG - OpenAI Sinhala guard dropped chunk {filename} after repeated English-heavy responses"
                    )
                    return {"text": "", "segments": []}
                log_debug(f"DEBUG - OpenAI keys: {list(result.keys())}")
                return result
            except httpx.HTTPStatusError as e:
                log_debug(f"DEBUG - OpenAI HTTP {e.response.status_code}: {e.response.text[:400]}")
                if e.response.status_code >= 500 and attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAY * 2); continue
                raise HTTPException(e.response.status_code, f"OpenAI error: {e.response.text}")
            except Exception as e:
                log_debug(f"DEBUG - OpenAI error: {e}")
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_DELAY); continue
                raise HTTPException(500, str(e))
    raise HTTPException(500, "OpenAI retries exhausted")


async def _openai_large(
    filename: str,
    input_path: str,
    lang: str,
    progress_callback=None,
    concurrency: int = 1,
):
    """Split large files into clean 16 kHz mono WAV chunks for GPT-4o-transcribe."""
    out_dir = tempfile.mkdtemp()
    out_pattern = os.path.join(out_dir, "chunk_%03d.wav")

    try:
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        proc = await asyncio.create_subprocess_exec(
            ffmpeg_exe,
            "-i", input_path,
            "-f", "segment",
            "-segment_time", str(OPENAI_CHUNK_SECONDS),
            "-ar", "16000",
            "-ac", "1",
            "-sample_fmt", "s16",
            "-acodec", "pcm_s16le",
            out_pattern,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(500, f"FFmpeg split failed: {err.decode()[:500]}")

        chunks = sorted(f for f in os.listdir(out_dir) if f.startswith("chunk_"))
        total_chunks = len(chunks)
        if progress_callback:
            progress_callback(0, total_chunks)

        async def process_chunk(index: int, name: str):
            with open(os.path.join(out_dir, name), "rb") as f:
                data = f.read()
            log_debug(f"DEBUG - OpenAI chunk {index+1}/{total_chunks} ({len(data)} bytes)")
            return index, await _openai_send(name, data, lang)

        if concurrency <= 1:
            results = []
            for i, name in enumerate(chunks):
                results.append(await process_chunk(i, name))
                if progress_callback:
                    progress_callback(i + 1, total_chunks)
        else:
            semaphore = asyncio.Semaphore(concurrency)

            async def sem_task(index: int, name: str):
                async with semaphore:
                    return await process_chunk(index, name)

            tasks = [asyncio.create_task(sem_task(i, name)) for i, name in enumerate(chunks)]
            results = []
            completed = 0

            for task in asyncio.as_completed(tasks):
                results.append(await task)
                completed += 1
                if progress_callback:
                    progress_callback(completed, total_chunks)

        full_text, segments = "", []
        for _, res in sorted(results, key=lambda item: item[0]):
            if "text" in res:
                full_text += res["text"] + " "
            if "segments" in res:
                segments.extend(res["segments"])

        return {
            "text": _clean_openai_transcript_text(full_text.strip()),
            "segments": segments,
        }
    finally:
        for f in os.listdir(out_dir):
            os.remove(os.path.join(out_dir, f))
        os.rmdir(out_dir)

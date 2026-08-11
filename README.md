# ProbablyWhatYouSaid AI

ProbablyWhatYouSaid AI is a split frontend/backend workspace for audio transcription and hybrid browser/native video conversion.

The app lets you:

- upload audio and transcribe it with Azure Speech, GPT-4o Transcribe, or Google Speech-to-Text
- review speaker-grouped output and the full transcript side by side
- copy the final transcript to the clipboard from the results panel
- extract only the English passages from a mixed-language recording with the **English only** toggle
- upload an MP4 or MOV file, convert it to MP3, and send that MP3 straight into the transcription flow

## Workspace layout

- `frontend/` - Next.js 16 app for upload, conversion, transcription, and transcript review
- `backend/` - FastAPI transcription API with Azure, OpenAI, and Google provider routing

## Local setup

### 1. Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8100
```

Start the UI:

```bash
npm run dev
```

By default, Next.js runs on `http://localhost:3000`. The backend sample CORS config also allows `3001` and `3100` if you need an alternate local port.

### 2. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Copy the sample environment file and fill in the provider credentials you want to use:

```bash
copy .env.example .env
```

Optional hardening knobs in `backend/.env`:

- `MAX_UPLOAD_SIZE_MB=256` limits how much data one upload can send while still allowing long-form recordings to use the background queue.
- `MAX_VIDEO_UPLOAD_SIZE_MB=8192` limits original MP4/MOV uploads handled by the native FFmpeg fallback. Keep enough free temporary-disk space for roughly twice the largest input video.
- `MAX_CONCURRENT_TRANSCRIPTIONS=2` caps simultaneous provider work.
- `MAX_ACTIVE_BACKGROUND_JOBS=4` rejects new large uploads when the queue is already busy.

Start the API:

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8100
```

Backend docs are available at `http://127.0.0.1:8100/docs`.

## Key frontend flows

### Transcribe

1. Upload an audio file.
2. Choose the engine and language.
3. Optionally tick **English only** to keep just the English passages (see below).
4. Submit the file.
5. Read the transcript in speaker-grouped and full-text layouts.
6. Use the built-in copy button to place the full transcript on the clipboard.

### English only (mixed-language audio)

For recordings that mix English with another language (for example English + Sinhala),
tick **English only** to return just the passages spoken in English and drop the rest.
Filtering is script- and word-based, so it works for the diarized engines (Azure, Google)
and for GPT-4o Transcribe, which returns a plain text blob with no segments.

- Non-Latin scripts (Sinhala, Tamil, Kannada, ...) are dropped.
- Romanized non-English text is dropped, including long runs and choppy short fragments,
  while isolated English proper-noun lists (such as `Ethiopian Arabica, Brazilian Arabica`)
  are kept.
- It works at the level of whole passages, so a single sentence that mixes languages
  mid-way ("add the espresso `එක`") is classified as a whole, not word by word.

For the cleanest result on mixed audio, use **GPT-4o Transcribe** with **Auto-detect**
(it handles code-switching best) and leave the language on Auto-detect rather than a fixed
language, then enable **English only**. Note that where the model *translates* speech into
English, that text is genuine English and cannot be filtered out.

### Video to MP3

1. Switch to `Video to MP3`.
2. Upload an MP4 or MOV file.
3. Wait for MP3 conversion. Files up to 512 MB use ffmpeg.wasm in the browser; larger files use native FFmpeg through the local backend. Browser failures automatically retry through the native path.
4. The generated MP3 is automatically selected back in `Transcribe`.
5. Download the MP3 or transcribe it immediately.

The MP3 is encoded speech-optimized (16 kHz, mono, 64 kbps). Every transcription
provider downsamples to 16 kHz mono internally, so this keeps full transcription
quality while producing a file roughly 3x smaller than 44.1 kHz stereo — long
recordings stay under `MAX_UPLOAD_SIZE_MB`.

## Scripts

### Frontend

- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run lint`

### Backend

- `python -m uvicorn main:app --host 127.0.0.1 --port 8100`
- `python test_upload.py`

## Notes

- Large transcription jobs can be queued and polled through `GET /transcribe/jobs/{job_id}`.
- Uploads above `MAX_UPLOAD_SIZE_MB` are rejected before multipart parsing to reduce disk and CPU abuse.
  If an upload exceeds the limit, the browser may show a generic "could not reach the API"
  error instead of the `413`, because the request is rejected mid-upload — shrink the file
  (re-run `Video to MP3`) or raise `MAX_UPLOAD_SIZE_MB`.
- GPT-4o transcripts are cleaned automatically: repeated tokens, phrases, and multi-sentence
  loops are collapsed, and stray instruction text the model sometimes echoes into its output
  is stripped.
- Browser-side video conversion loads FFmpeg from jsDelivr on first use. Large files bypass WebAssembly memory limits through the backend's bundled native FFmpeg binary.
- If frontend and backend run on different origins, update `CORS_ALLOWED_ORIGINS` in `backend/.env`.

## Repo hygiene

- Runtime secrets live in `.env` files and stay ignored.
- Example env files such as `backend/.env.example` are committed on purpose.
- Generated output such as `.next/`, logs, caches, and job store artifacts are ignored.

# ProbablyWhatYouSaid AI

ProbablyWhatYouSaid AI is a split frontend/backend workspace for audio transcription and browser-side video conversion.

The app lets you:

- upload audio and transcribe it with Azure Speech, GPT-4o Transcribe, or Google Speech-to-Text
- review speaker-grouped output and the full transcript side by side
- copy the final transcript to the clipboard from the results panel
- upload an MP4 or MOV file, convert it to MP3 in the browser, and send that MP3 straight into the transcription flow

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

Start the API:

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8100
```

Backend docs are available at `http://127.0.0.1:8100/docs`.

## Key frontend flows

### Transcribe

1. Upload an audio file.
2. Choose the engine and language.
3. Submit the file.
4. Read the transcript in speaker-grouped and full-text layouts.
5. Use the built-in copy button to place the full transcript on the clipboard.

### Video to MP3

1. Switch to `Video to MP3`.
2. Upload an MP4 or MOV file.
3. Wait for ffmpeg.wasm to generate the MP3 in the browser.
4. The generated MP3 is automatically selected back in `Transcribe`.
5. Download the MP3 or transcribe it immediately.

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
- Browser-side video conversion loads FFmpeg from jsDelivr on first use.
- If frontend and backend run on different origins, update `CORS_ALLOWED_ORIGINS` in `backend/.env`.

## Repo hygiene

- Runtime secrets live in `.env` files and stay ignored.
- Example env files such as `backend/.env.example` are committed on purpose.
- Generated output such as `.next/`, logs, caches, and job store artifacts are ignored.

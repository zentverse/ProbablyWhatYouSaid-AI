# Probably what you said AI

Probably what you said AI is a minimal transcription workspace built with
Next.js. It lets you upload an audio file, choose a transcription engine, and
read the result in two ways:

- a speaker-grouped conversation view when speaker metadata is available
- a full transcript view for direct reading and copy/paste workflows

This repository contains the frontend application. It expects a separate
transcription API to be available and reachable from the browser.

## What the app does

The UI is designed around a simple transcription flow:

1. Select an audio file
2. Choose the transcription engine
3. Choose a language or leave it on auto-detect
4. Submit the file to the API
5. Watch status updates while the transcript is processed
6. Review the returned transcript in a clean reading layout

Large files can be handled as background jobs by the API. When that happens,
the frontend polls the job endpoint until the final transcript is ready.

## Supported engines

The current UI supports three backend providers:

- `Azure Speech`
- `GPT-4o Transcribe`
- `Google Speech-to-Text`

The actual availability of each provider depends on how the backend API is
configured.

## Supported languages

The language picker includes:

- Auto-detect
- Sinhala
- English
- Tamil
- Hindi
- Arabic
- Chinese
- Japanese
- Korean
- French
- German
- Spanish
- Portuguese
- Russian
- Swedish

## Tech stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4

## API contract expected by the frontend

The frontend expects a backend with these endpoints:

- `POST /transcribe`
- `GET /transcribe/jobs/{job_id}`

The `POST /transcribe` endpoint should accept multipart form data with:

- `file`
- `language`
- `provider`

It should return either:

- a completed transcript payload immediately, or
- an HTTP `202` response with a background `job_id`

The job endpoint should return status values like:

- `queued`
- `processing`
- `completed`
- `failed`

## Transcript response shape

The UI is built to handle responses that include:

- `text`
- `segments`
- optional `speaker` values inside each segment

When speaker information is present, the app renders grouped speaker blocks.
When it is not present, the app falls back to the full transcript view without
inventing speakers.

## Local development

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

By default, Next.js runs on `http://localhost:3000`.

If you want to run the frontend against a backend that only allows a specific
origin such as `http://127.0.0.1:3100`, start it like this instead:

```bash
npm run dev -- --hostname 127.0.0.1 --port 3100
```

## Environment variables

Create `.env.local` and set:

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8100
```

This should point to the transcription API used by the app.

## Available scripts

- `npm run dev` - start the Next.js development server
- `npm run build` - create a production build
- `npm run start` - run the production server
- `npm run lint` - lint the codebase

## Project structure

```text
src/
  app/
    globals.css
    layout.tsx
    page.tsx
  components/
    TranscriberClient.tsx
```

## UI behavior worth knowing

- The word counter uses locale-aware segmentation when available.
- Background-job polling retries transient connection failures before showing an error.
- Sinhala users are warned when `GPT-4o Transcribe` is selected because Azure
  Speech is generally the safer default for long Sinhala recordings.

## Production notes

This app can be deployed as a standard Next.js application. Make sure the
deployed environment can reach the transcription API defined by
`NEXT_PUBLIC_API_BASE_URL`.

If the frontend and backend are hosted on different origins, configure backend
CORS to allow the frontend origin.

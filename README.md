# Quran Coach MVP — مدرّب التلاوة

A mobile-first Arabic PWA for practicing Surah Al-Fatiha. The user records an ayah, the backend transcribes it, compares the spoken words with the expected ayah, highlights mismatches, and stores lightweight progress locally on the device.

## What works now

- Arabic RTL mobile UI
- Family profile buttons: أبي / أمي / أنا
- Surah Al-Fatiha, ayah by ayah
- Microphone recording and playback
- Word-level Arabic transcription using OpenAI Audio Transcriptions
- Word alignment + score + first actionable correction
- PWA manifest + service worker, so it can be added to a phone home screen
- FastAPI backend, Docker-ready for Google Cloud Run
- Optional adapter hook for a dedicated Quran phoneme/tajweed endpoint

## Important limitation

The default engine is **word-level**, not a tajweed authority. It can detect missing/different words but does not yet reliably judge makharij, madd, ghunnah, qalqalah, tafkhim, etc. A dedicated Quran phoneme model should be connected for that stage. Automatic feedback can be wrong and should not replace a qualified Quran teacher.

## Local run

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
cp .env.example .env
# put your OPENAI_API_KEY in .env or export it in your shell
export OPENAI_API_KEY="..."
uvicorn main:app --reload --port 8000
```

Health check: `http://localhost:8000/health`

### 2. Frontend

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

> Microphone access normally requires HTTPS in production. `localhost` is allowed during development.

## Deploy backend to Google Cloud Run

From the `backend` folder, with Google Cloud CLI configured:

```bash
gcloud run deploy quran-coach-api \
  --source . \
  --region europe-west4 \
  --allow-unauthenticated \
  --set-env-vars "CORS_ORIGINS=https://YOUR-VERCEL-DOMAIN" \
  --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest"
```

Create the `OPENAI_API_KEY` secret first in Google Secret Manager.

Copy the resulting Cloud Run HTTPS URL.

## Deploy frontend to Vercel

1. Import the `frontend` folder into Vercel.
2. Add environment variable:
   - `NEXT_PUBLIC_API_URL=https://YOUR-CLOUD-RUN-URL`
3. Deploy.
4. Update Cloud Run `CORS_ORIGINS` to the final Vercel/custom domain.
5. Open the site on iPhone/Android and choose **Add to Home Screen**.

## Quran-Lab / phoneme engine next step

The backend supports an optional `QURAN_MODEL_ENDPOINT`. When configured, it is used before OpenAI transcription. The endpoint should accept multipart fields:

- `audio`: recorded audio
- `expected_text`: canonical ayah text

and return:

```json
{
  "transcript": "...",
  "score": 91,
  "words": [
    {"expected":"قل", "heard":"قل", "status":"correct"}
  ],
  "feedback": "...",
  "warning": "..."
}
```

For Quran-Lab `zipformer_p-arabic-v3.1`, you must first accept the model's gated license terms. It is intended for Quran phoneme recognition and encodes tajweed-relevant distinctions. Do not present its output as an authoritative religious judgment.

## Recommended next build milestones

1. Connect Quran-Lab v3.1 phoneme inference.
2. Add reference recitation playback per ayah.
3. Add repeat-a-word mode.
4. Add Supabase accounts and cloud-synced progress.
5. Add all surahs from a verified Quran text source.
6. Add a memorization mode: listen → read → hide text → test → review mistakes.

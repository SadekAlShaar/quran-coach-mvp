import os
import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from models import AnalysisResponse, WordResult
from services.text_compare import align_words
from services.transcription import transcribe_with_gemini
from services.quran_model import analyze_with_quran_endpoint

app = FastAPI(title="Quran Coach API", version="0.1.0")
origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
def health():
    return {"ok": True, "service": "quran-coach-api"}

@app.post("/analyze", response_model=AnalysisResponse)
async def analyze(
    audio: UploadFile = File(...),
    surah: int = Form(...),
    ayah: int = Form(...),
    expected_text: str = Form(...),
    profile: str = Form("user"),
):
    supported_surahs = {
        1: 7,   # Al-Fatiha
        98: 8,  # Al-Bayyinah
    }
    max_ayah = supported_surahs.get(surah)
    if max_ayah is None or not 1 <= ayah <= max_ayah:
        raise HTTPException(400, "This surah or ayah is not supported yet.")

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "Empty audio file.")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(413, "Audio file is too large.")

    # If a dedicated Quran endpoint is configured, it gets first priority.
    quran_endpoint = os.getenv("QURAN_MODEL_ENDPOINT", "").strip()
    if quran_endpoint:
        try:
            result = await analyze_with_quran_endpoint(
                quran_endpoint,
                os.getenv("QURAN_MODEL_TOKEN"),
                raw,
                audio.filename or "recitation.webm",
                audio.content_type or "audio/webm",
                expected_text,
            )
            # Expected adapter shape. This keeps the frontend stable while the engine can change.
            if all(k in result for k in ("transcript", "score", "words", "feedback")):
                return AnalysisResponse(mode="quran-phoneme", **result)
        except Exception:
            # Fall through to word-level analyzer rather than making the app unusable.
            pass

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            503,
            "No analysis engine configured. Add GEMINI_API_KEY for free-tier word-level feedback or QURAN_MODEL_ENDPOINT for phoneme/tajweed feedback.",
        )

    try:
        transcript = await transcribe_with_gemini(
            raw,
            audio.filename or "recitation.webm",
            audio.content_type or "audio/webm",
            api_key,
            os.getenv("GEMINI_TRANSCRIBE_MODEL", "gemini-3.5-transcribe"),
        )
    except httpx.HTTPStatusError as exc:
        detail = ""
        try:
            detail = exc.response.text[:500]
        except Exception:
            pass
        raise HTTPException(502, f"Gemini transcription error: {exc.response.status_code} {detail}")
    except Exception as exc:
        raise HTTPException(502, f"Could not transcribe audio with Gemini: {type(exc).__name__}: {exc}")

    aligned, score = align_words(expected_text, transcript)
    wrong = [x for x in aligned if x.status != "correct"]
    if not wrong:
        feedback = "ممتاز 👏 الكلمات مطابقة على مستوى النص. كررها مرة ثانية لتثبيت الحفظ."
    else:
        first = wrong[0]
        if first.status == "missing":
            feedback = f"جرّب مرة ثانية وانتبه لكلمة «{first.expected}»؛ النظام لم يسمعها بوضوح."
        elif first.status == "extra":
            feedback = f"سمع النظام كلمة إضافية «{first.heard}». أعد الآية بهدوء وبفواصل واضحة."
        else:
            feedback = f"ركّز على كلمة «{first.expected}». النظام سمعها أقرب إلى «{first.heard or 'غير واضح'}». أعدها ثم اقرأ الآية مرة ثانية."

    return AnalysisResponse(
        mode="word-level",
        transcript=transcript,
        score=score,
        words=[WordResult(expected=x.expected, heard=x.heard, status=x.status) for x in aligned],
        feedback=feedback,
        warning="هذه النسخة تقارن الكلمات المنطوقة ولا تقيس مخارج الحروف أو أحكام التجويد الدقيقة بعد.",
    )

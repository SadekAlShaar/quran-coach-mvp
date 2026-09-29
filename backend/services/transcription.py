import httpx

OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions"

async def transcribe_with_openai(audio_bytes: bytes, filename: str, content_type: str, api_key: str, model: str) -> str:
    headers = {"Authorization": f"Bearer {api_key}"}
    files = {"file": (filename, audio_bytes, content_type or "audio/webm")}
    data = {
        "model": model,
        "language": "ar",
        "response_format": "json",
    }
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(OPENAI_TRANSCRIPTIONS_URL, headers=headers, files=files, data=data)
        response.raise_for_status()
        payload = response.json()
        return (payload.get("text") or "").strip()

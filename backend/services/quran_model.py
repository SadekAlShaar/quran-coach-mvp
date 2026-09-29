"""Optional adapter hook for a dedicated Quran phoneme/tajweed model.

The production recommendation is Quran-Lab zipformer_p-arabic-v3.1 or a compatible
hosted service after accepting its license. The repository is gated, so this MVP
cannot silently download the model for the user.
"""
import httpx

async def analyze_with_quran_endpoint(endpoint: str, token: str | None, audio: bytes, filename: str, content_type: str, expected_text: str):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    files = {"audio": (filename, audio, content_type or "audio/webm")}
    data = {"expected_text": expected_text}
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(endpoint, headers=headers, files=files, data=data)
        r.raise_for_status()
        return r.json()

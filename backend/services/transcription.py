import httpx

GEMINI_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def _normalize_audio_mime(content_type: str) -> str:
    mime = (content_type or "audio/webm").split(";", 1)[0].strip().lower()
    aliases = {
        "audio/mp4": "audio/m4a",
        "audio/x-m4a": "audio/m4a",
        "audio/x-wav": "audio/wav",
    }
    return aliases.get(mime, mime)


async def transcribe_with_gemini(
    audio_bytes: bytes,
    filename: str,
    content_type: str,
    api_key: str,
    model: str = "gemini-3.5-transcribe",
) -> str:
    """Upload a short audio clip to Gemini Files API, transcribe it, then delete it.

    We intentionally use VERBATIM mode so the provider does not "clean up" the
    recitation before our own Quran word comparison runs.
    """
    mime_type = _normalize_audio_mime(content_type)
    headers = {"x-goog-api-key": api_key}
    uploaded_name = None

    async with httpx.AsyncClient(timeout=90) as client:
        # Start resumable upload.
        start_headers = {
            **headers,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(len(audio_bytes)),
            "X-Goog-Upload-Header-Content-Type": mime_type,
            "Content-Type": "application/json",
        }
        start = await client.post(
            GEMINI_UPLOAD_URL,
            headers=start_headers,
            json={"file": {"display_name": filename}},
        )
        start.raise_for_status()
        upload_url = start.headers.get("x-goog-upload-url")
        if not upload_url:
            raise RuntimeError("Gemini did not return an upload URL.")

        # Upload and finalize the actual bytes.
        upload = await client.post(
            upload_url,
            headers={
                "Content-Length": str(len(audio_bytes)),
                "X-Goog-Upload-Offset": "0",
                "X-Goog-Upload-Command": "upload, finalize",
                "Content-Type": mime_type,
            },
            content=audio_bytes,
        )
        upload.raise_for_status()
        file_payload = upload.json().get("file", {})
        file_uri = file_payload.get("uri")
        uploaded_name = file_payload.get("name")
        uploaded_mime = _normalize_audio_mime(file_payload.get("mimeType") or mime_type)
        if not file_uri:
            raise RuntimeError("Gemini upload completed without a file URI.")

        try:
            # Gemini 3.5 Transcribe is designed specifically for speech-to-text.
            request = {
                "contents": [
                    {
                        "parts": [
                            {
                                "fileData": {
                                    "fileUri": file_uri,
                                    "mimeType": uploaded_mime,
                                }
                            }
                        ]
                    }
                ],
                "generationConfig": {
                    "audioTranscriptionConfig": {
                        "languageCodes": ["ar"],
                        "mode": "VERBATIM",
                    }
                },
            }
            response = await client.post(
                f"{GEMINI_API_BASE}/models/{model}:generateContent",
                headers={**headers, "Content-Type": "application/json"},
                json=request,
            )
            response.raise_for_status()
            payload = response.json()
            parts = (
                payload.get("candidates", [{}])[0]
                .get("content", {})
                .get("parts", [])
            )
            text = " ".join(
                part.get("text", "").strip()
                for part in parts
                if isinstance(part, dict) and part.get("text")
            ).strip()
            if not text:
                raise RuntimeError("Gemini returned an empty transcript.")
            return text
        finally:
            # Privacy: delete the temporary audio immediately when possible.
            if uploaded_name:
                try:
                    await client.delete(
                        f"{GEMINI_API_BASE}/{uploaded_name}",
                        headers=headers,
                    )
                except Exception:
                    pass

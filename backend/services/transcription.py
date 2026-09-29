import asyncio
import httpx

GEMINI_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_INTERACTIONS_URL = f"{GEMINI_API_BASE}/interactions"


def _normalize_audio_mime(content_type: str) -> str:
    mime = (content_type or "audio/webm").split(";", 1)[0].strip().lower()
    aliases = {
        "audio/mp4": "audio/m4a",
        "audio/x-m4a": "audio/m4a",
        "audio/x-wav": "audio/wav",
    }
    return aliases.get(mime, mime)


def _extract_interaction_text(payload: dict) -> str:
    # Some API/SDK shapes may expose a convenience field.
    direct = payload.get("output_text") or payload.get("outputText")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    # Raw REST Interactions API returns model output in steps[].content[].text.
    texts = []
    for step in payload.get("steps", []) or []:
        if not isinstance(step, dict):
            continue
        for content in step.get("content", []) or []:
            if not isinstance(content, dict):
                continue
            text = content.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())

    return " ".join(texts).strip()


async def _wait_until_file_active(client: httpx.AsyncClient, file_name: str, headers: dict) -> dict:
    """Wait briefly if Gemini still reports the uploaded audio as PROCESSING."""
    last_payload = {}
    for _ in range(10):
        response = await client.get(f"{GEMINI_API_BASE}/{file_name}", headers=headers)
        response.raise_for_status()
        last_payload = response.json()
        state = str(last_payload.get("state") or "").upper()

        if state in ("", "ACTIVE"):
            return last_payload
        if state == "FAILED":
            raise RuntimeError(f"Gemini file processing failed: {last_payload.get('error')}")

        await asyncio.sleep(0.5)

    raise RuntimeError(
        f"Gemini audio file did not become ACTIVE in time. Last state: {last_payload.get('state')}"
    )


async def transcribe_with_gemini(
    audio_bytes: bytes,
    filename: str,
    content_type: str,
    api_key: str,
    model: str = "gemini-3.5-transcribe",
) -> str:
    """Upload a short audio clip and transcribe it with Gemini Interactions API.

    The Interactions API is the current endpoint documented for Gemini 3.5
    Transcribe. We use verbatim mode because Quran Coach must compare what was
    actually spoken rather than a cleaned-up transcript.
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

        # Upload and finalize bytes.
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

        if not file_uri or not uploaded_name:
            raise RuntimeError("Gemini upload completed without a usable file URI/name.")

        try:
            # Files can briefly be PROCESSING after upload.
            fetched = await _wait_until_file_active(client, uploaded_name, headers)
            file_uri = fetched.get("uri") or file_uri
            uploaded_mime = _normalize_audio_mime(fetched.get("mimeType") or uploaded_mime)

            # Current Gemini 3.5 Transcribe endpoint.
            request = {
                "model": model,
                "input": [
                    {
                        "type": "audio",
                        "uri": file_uri,
                        "mime_type": uploaded_mime,
                    }
                ],
                "generation_config": {
                    "transcription_config": {
                        "language_codes": ["ar"],
                        "mode": {"type": "verbatim"},
                    }
                },
            }

            response = await client.post(
                GEMINI_INTERACTIONS_URL,
                headers={**headers, "Content-Type": "application/json"},
                json=request,
            )
            response.raise_for_status()
            payload = response.json()

            text = _extract_interaction_text(payload)
            if not text:
                status = payload.get("status")
                error = payload.get("error")
                raise RuntimeError(
                    f"Gemini returned no transcript. status={status!r}, error={error!r}, "
                    f"response_keys={list(payload.keys())}"
                )
            return text
        finally:
            # Privacy: delete the temporary audio immediately when possible.
            if uploaded_name:
                try:
                    await client.delete(f"{GEMINI_API_BASE}/{uploaded_name}", headers=headers)
                except Exception:
                    pass

from typing import Literal
from pydantic import BaseModel

class WordResult(BaseModel):
    expected: str
    heard: str | None = None
    status: Literal["correct", "wrong", "missing", "extra"]

class AnalysisResponse(BaseModel):
    mode: str
    transcript: str
    score: int
    words: list[WordResult]
    feedback: str
    warning: str | None = None

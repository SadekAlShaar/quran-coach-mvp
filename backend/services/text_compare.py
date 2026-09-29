import re
import unicodedata
from dataclasses import dataclass

ARABIC_DIACRITICS = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]")


def normalize_arabic(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = ARABIC_DIACRITICS.sub("", text)
    text = text.replace("ـ", "")
    table = str.maketrans({
        "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
        "ى": "ي", "ؤ": "و", "ئ": "ي",
    })
    text = text.translate(table)
    text = re.sub(r"[^\u0621-\u063A\u0641-\u064A\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def word_similarity(a: str, b: str) -> float:
    a, b = normalize_arabic(a), normalize_arabic(b)
    denom = max(len(a), len(b), 1)
    return 1 - (_distance(a, b) / denom)

@dataclass
class AlignmentItem:
    expected: str
    heard: str | None
    status: str


def align_words(expected_text: str, heard_text: str) -> tuple[list[AlignmentItem], int]:
    expected_original = expected_text.split()
    heard_original = heard_text.split()
    e = [normalize_arabic(x) for x in expected_original]
    h = [normalize_arabic(x) for x in heard_original]
    n, m = len(e), len(h)

    # DP cost: exact match 0, close substitution 0.55, wrong substitution 1, insertion/deletion 1
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    op = [[""] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1): dp[i][0], op[i][0] = float(i), "del"
    for j in range(1, m + 1): dp[0][j], op[0][j] = float(j), "ins"

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            sim = word_similarity(e[i-1], h[j-1])
            sub_cost = 0 if sim >= 0.93 else (0.55 if sim >= 0.67 else 1.0)
            choices = [
                (dp[i-1][j-1] + sub_cost, "match" if sub_cost == 0 else "sub"),
                (dp[i-1][j] + 1, "del"),
                (dp[i][j-1] + 1, "ins"),
            ]
            dp[i][j], op[i][j] = min(choices, key=lambda x: x[0])

    items: list[AlignmentItem] = []
    i, j = n, m
    while i > 0 or j > 0:
        action = op[i][j]
        if i > 0 and j > 0 and action in ("match", "sub"):
            items.append(AlignmentItem(expected_original[i-1], heard_original[j-1], "correct" if action == "match" else "wrong"))
            i -= 1; j -= 1
        elif i > 0 and (j == 0 or action == "del"):
            items.append(AlignmentItem(expected_original[i-1], None, "missing"))
            i -= 1
        else:
            # Keep extras visible, using the heard word as the display token.
            items.append(AlignmentItem(heard_original[j-1], heard_original[j-1], "extra"))
            j -= 1

    items.reverse()
    expected_count = max(len(expected_original), 1)
    penalties = sum(0 if x.status == "correct" else (0.65 if x.status == "wrong" else 1) for x in items)
    score = round(max(0, min(100, (1 - penalties / expected_count) * 100)))
    return items, score

export type WordStatus = "correct" | "wrong" | "missing" | "extra";

export type WordResult = {
  expected: string;
  heard?: string | null;
  status: WordStatus;
};

export type LocalAnalysis = {
  mode: "browser-free";
  transcript: string;
  score: number;
  words: WordResult[];
  feedback: string;
  warning?: string | null;
};

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;

export function normalizeArabic(input: string): string {
  return (input || "")
    .normalize("NFKC")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^ء-غف-ي\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const left = normalizeArabic(a);
  const right = normalizeArabic(b);
  const denominator = Math.max(left.length, right.length, 1);
  return 1 - distance(left, right) / denominator;
}

export function analyzeTranscript(expectedText: string, heardText: string): LocalAnalysis {
  const expectedOriginal = expectedText.trim().split(/\s+/).filter(Boolean);
  const heardOriginal = heardText.trim().split(/\s+/).filter(Boolean);
  const expected = expectedOriginal.map(normalizeArabic);
  const heard = heardOriginal.map(normalizeArabic);
  const n = expected.length;
  const m = heard.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  const op: string[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(""));

  for (let i = 1; i <= n; i++) {
    dp[i][0] = i;
    op[i][0] = "del";
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = j;
    op[0][j] = "ins";
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similarity(expected[i - 1], heard[j - 1]);
      const substitutionCost = sim >= 0.93 ? 0 : sim >= 0.67 ? 0.55 : 1;
      const choices: Array<[number, string]> = [
        [dp[i - 1][j - 1] + substitutionCost, substitutionCost === 0 ? "match" : "sub"],
        [dp[i - 1][j] + 1, "del"],
        [dp[i][j - 1] + 1, "ins"],
      ];
      choices.sort((a, b) => a[0] - b[0]);
      dp[i][j] = choices[0][0];
      op[i][j] = choices[0][1];
    }
  }

  const items: WordResult[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const action = op[i]?.[j] || (i > 0 ? "del" : "ins");
    if (i > 0 && j > 0 && (action === "match" || action === "sub")) {
      items.push({
        expected: expectedOriginal[i - 1],
        heard: heardOriginal[j - 1],
        status: action === "match" ? "correct" : "wrong",
      });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || action === "del")) {
      items.push({ expected: expectedOriginal[i - 1], heard: null, status: "missing" });
      i -= 1;
    } else {
      items.push({ expected: heardOriginal[j - 1], heard: heardOriginal[j - 1], status: "extra" });
      j -= 1;
    }
  }

  items.reverse();
  const expectedCount = Math.max(expectedOriginal.length, 1);
  const penalties = items.reduce((sum, item) => {
    if (item.status === "correct") return sum;
    if (item.status === "wrong") return sum + 0.65;
    return sum + 1;
  }, 0);
  const score = Math.round(Math.max(0, Math.min(100, (1 - penalties / expectedCount) * 100)));
  const mistakes = items.filter((item) => item.status !== "correct").length;

  let feedback = "ممتاز، الكلمات التي التقطها المتصفح مطابقة للآية ✅";
  if (mistakes > 0) {
    feedback = `في ${mistakes} موضع يحتاج إعادة. اضغط على الكلمة الحمراء واسمع النطق الصحيح.`;
  }

  return {
    mode: "browser-free",
    transcript: heardText.trim(),
    score,
    words: items,
    feedback,
    warning:
      "التصحيح هنا مبني على تحويل الكلام إلى نص من المتصفح، وليس فحصًا دقيقًا للمخارج أو أحكام التجويد.",
  };
}

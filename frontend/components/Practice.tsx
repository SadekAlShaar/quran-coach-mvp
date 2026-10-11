"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { surahs } from "@/lib/surahs";
import { analyzeTranscript, type LocalAnalysis, type WordResult } from "@/lib/localAnalysis";

type Analysis = LocalAnalysis;

type PositionedWord = WordResult & {
  resultIndex: number;
  quranPosition: number | null;
};

const PROFILES = ["أبي", "أمي", "أنا"];

export default function Practice() {
  const [profile, setProfile] = useState("أنا");
  const [surahNo, setSurahNo] = useState(1);
  const [ayahNo, setAyahNo] = useState(1);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("اضغط على الميكروفون واقرأ الآية كاملة.");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [liveTranscript, setLiveTranscript] = useState("");

  const recognitionRef = useRef<any>(null);
  const finalTranscriptRef = useRef("");
  const latestTranscriptRef = useRef("");
  const shouldAnalyzeRef = useRef(false);
  const keepListeningRef = useRef(false);
  const recognitionSessionRef = useRef(0);
  const wordAudio = useRef<HTMLAudioElement | null>(null);
  const ayahAudio = useRef<HTMLAudioElement | null>(null);
  const [playingWordPosition, setPlayingWordPosition] = useState<number | null>(null);
  const [playingAllMistakes, setPlayingAllMistakes] = useState(false);
  const [playingAyah, setPlayingAyah] = useState(false);

  const surah = useMemo(() => surahs.find((s) => s.number === surahNo) ?? surahs[0], [surahNo]);
  const ayah = useMemo(() => surah.ayahs.find((a) => a.number === ayahNo) ?? surah.ayahs[0], [surah, ayahNo]);

  const wordsWithPositions = useMemo<PositionedWord[]>(() => {
    if (!analysis) return [];
    let quranPosition = 0;
    return analysis.words.map((word, resultIndex) => {
      if (word.status !== "extra") quranPosition += 1;
      return {
        ...word,
        resultIndex,
        quranPosition: word.status === "extra" ? null : quranPosition,
      };
    });
  }, [analysis]);

  useEffect(() => {
    const saved = localStorage.getItem("quran-coach-profile");
    if (saved) setProfile(saved);

    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSpeechSupported(Boolean(SpeechRecognitionCtor));

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler as EventListener);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      window.removeEventListener("beforeinstallprompt", handler as EventListener);
      keepListeningRef.current = false;
      try { recognitionRef.current?.abort(); } catch {}
    };
  }, []);

  function chooseProfile(name: string) {
    setProfile(name);
    localStorage.setItem("quran-coach-profile", name);
  }

  function chooseSurah(nextSurahNo: number) {
    stopRecognition(false);
    stopWordAudio();
    stopAyahAudio();
    setSurahNo(nextSurahNo);
    setAyahNo(1);
    setAnalysis(null);
    setLiveTranscript("");
    setStatus("اضغط على الميكروفون واقرأ الآية كاملة.");
  }

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
  }

  function quranWordAudioUrl(position: number) {
    const chapter = String(surah.number).padStart(3, "0");
    const verse = String(ayah.number).padStart(3, "0");
    const word = String(position).padStart(3, "0");
    return `https://audio.qurancdn.com/wbw/${chapter}_${verse}_${word}.mp3`;
  }

  function quranAyahAudioUrl() {
    const chapter = String(surah.number).padStart(3, "0");
    const verse = String(ayah.number).padStart(3, "0");
    return `https://verses.quran.com/Alafasy/mp3/${chapter}${verse}.mp3`;
  }

  function stopAyahAudio() {
    if (ayahAudio.current) {
      ayahAudio.current.pause();
      ayahAudio.current.currentTime = 0;
      ayahAudio.current = null;
    }
    setPlayingAyah(false);
  }

  async function playAyahWithTajweed(): Promise<void> {
    // iOS WebKit can break a later SpeechRecognition session if media plays
    // while a recognizer is still around. Tear recognition down hard first.
    hardResetRecognition();
    stopWordAudio();
    stopAyahAudio();
    setPlayingAyah(true);
    const player = new Audio(quranAyahAudioUrl());
    ayahAudio.current = player;

    await new Promise<void>((resolve, reject) => {
      player.onended = () => resolve();
      player.onerror = () => reject(new Error("Could not load Quran ayah audio"));
      player.play().catch(reject);
    }).finally(() => {
      try {
        player.pause();
        player.removeAttribute("src");
        player.load();
      } catch {}
      if (ayahAudio.current === player) ayahAudio.current = null;
      setPlayingAyah(false);
    });
  }

  function stopWordAudio() {
    if (wordAudio.current) {
      wordAudio.current.pause();
      wordAudio.current.currentTime = 0;
      wordAudio.current = null;
    }
    setPlayingWordPosition(null);
  }

  async function playWord(position: number): Promise<void> {
    hardResetRecognition();
    stopAyahAudio();
    stopWordAudio();
    setPlayingWordPosition(position);
    const player = new Audio(quranWordAudioUrl(position));
    wordAudio.current = player;

    await new Promise<void>((resolve, reject) => {
      player.onended = () => resolve();
      player.onerror = () => reject(new Error("Could not load Quran word audio"));
      player.play().catch(reject);
    }).finally(() => {
      try {
        player.pause();
        player.removeAttribute("src");
        player.load();
      } catch {}
      if (wordAudio.current === player) wordAudio.current = null;
      setPlayingWordPosition((current) => (current === position ? null : current));
    });
  }

  async function hearAllMistakes() {
    const mistakes = wordsWithPositions.filter(
      (word) => (word.status === "wrong" || word.status === "missing") && word.quranPosition !== null
    );
    if (!mistakes.length) return;

    setPlayingAllMistakes(true);
    try {
      for (const word of mistakes) {
        if (word.quranPosition !== null) {
          await playWord(word.quranPosition);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } catch (error) {
      console.error(error);
      setStatus("ما قدرت شغّل نطق الكلمة. جرّب مرة ثانية وتأكد من اتصال الإنترنت.");
    } finally {
      setPlayingAllMistakes(false);
    }
  }

  function finishAnalysis(transcript: string) {
    setBusy(true);
    const cleanTranscript = transcript.trim();

    if (!cleanTranscript) {
      setAnalysis(null);
      setStatus("ما قدرت أسمع كلمات واضحة. قرّب الموبايل واحكي بصوت أوضح ثم جرّب مرة ثانية.");
      setBusy(false);
      return;
    }

    const result = analyzeTranscript(ayah.simpleText, cleanTranscript);
    setAnalysis(result);
    setStatus(result.feedback);
    localStorage.setItem(
      `progress-${profile}-${surah.number}-${ayah.number}`,
      JSON.stringify({ score: result.score, at: new Date().toISOString() })
    );
    setBusy(false);
  }

  function hardResetRecognition() {
    keepListeningRef.current = false;
    shouldAnalyzeRef.current = false;
    recognitionSessionRef.current += 1;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      try { recognition.onend = null; } catch {}
      try { recognition.onerror = null; } catch {}
      try { recognition.abort(); } catch {}
    }
    setRecording(false);
  }

  function launchRecognition(sessionId: number) {
    if (!keepListeningRef.current || sessionId !== recognitionSessionRef.current) return;

    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setSpeechSupported(false);
      keepListeningRef.current = false;
      setRecording(false);
      setStatus("هذا المتصفح لا يدعم التعرف الصوتي المجاني. جرّب Chrome على Android/Windows أو Safari حديث على iPhone.");
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "ar-SA";
    // A short recognition session is much more reliable across repeated attempts.
    // When Chrome/Safari ends it because of a pause, onend starts a fresh one while
    // the user is still in recording mode.
    // Keep one recognition session alive until the user taps "انتهيت".
    // Auto-restarting from onend is unreliable on iPhone because a restart
    // may happen without a fresh user gesture and WebKit can report not-allowed.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      if (sessionId !== recognitionSessionRef.current) return;

      let finalPart = "";
      let interimPart = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const spoken = event.results[i][0]?.transcript ?? "";
        if (event.results[i].isFinal) finalPart += ` ${spoken}`;
        else interimPart += ` ${spoken}`;
      }

      if (finalPart.trim()) {
        finalTranscriptRef.current = `${finalTranscriptRef.current} ${finalPart}`.trim();
      }

      const combined = `${finalTranscriptRef.current} ${interimPart}`.trim();
      latestTranscriptRef.current = combined;
      setLiveTranscript(combined);
      if (combined) setStatus(`عم اسمعك… ${combined}`);
    };

    recognition.onerror = (event: any) => {
      if (sessionId !== recognitionSessionRef.current) return;
      const error = event?.error;
      console.error("SpeechRecognition error", error);

      if (error === "not-allowed" || error === "service-not-allowed") {
        keepListeningRef.current = false;
        setRecording(false);
        setStatus("المتصفح رفض جلسة التعرف الصوتي هالمرة. إذا الميكروفون مسموح أصلًا، لا تغيّر الإذن؛ اضغط «ابدأ القراءة» من جديد. على iPhone هذا خلل معروف في WebKit.");
      } else if (error === "no-speech") {
        if (keepListeningRef.current) {
          setStatus("ما سمعت كلام واضح. اضغط «ابدأ القراءة» مرة ثانية وبلّش مباشرة بعد الضغط.");
        }
      } else if (error === "aborted") {
        // Expected when changing surah/ayah or cleaning up an old recognizer.
      } else {
        setStatus("التعرف الصوتي توقف للحظة. عم حاول اسمعك من جديد…");
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (sessionId !== recognitionSessionRef.current) return;

      if (keepListeningRef.current) {
        // Never auto-restart on iPhone. A timer-based restart can lose the
        // direct user gesture and WebKit may return a fake permission error.
        keepListeningRef.current = false;
        setRecording(false);
        const heard = (finalTranscriptRef.current || latestTranscriptRef.current).trim();
        if (heard) {
          finishAnalysis(heard);
        } else {
          setStatus("جلسة الاستماع انتهت. اضغط «ابدأ القراءة» مرة ثانية وابدأ القراءة مباشرة.");
        }
        return;
      }

      setRecording(false);
      if (shouldAnalyzeRef.current) {
        shouldAnalyzeRef.current = false;
        finishAnalysis(finalTranscriptRef.current || latestTranscriptRef.current);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (error) {
      console.error("Could not start SpeechRecognition", error);
      recognitionRef.current = null;
      keepListeningRef.current = false;
      setRecording(false);
      setStatus("ما قدرت أبدأ جلسة الميكروفون. اضغط «ابدأ القراءة» مرة ثانية. إذا كنت على iPhone، ابدأ القراءة مباشرة بعد الضغط.");
    }
  }

  function startRecording() {
    if (recording || busy) return;

    setAnalysis(null);
    setLiveTranscript("");
    finalTranscriptRef.current = "";
    latestTranscriptRef.current = "";
    shouldAnalyzeRef.current = false;
    keepListeningRef.current = true;

    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setSpeechSupported(false);
      keepListeningRef.current = false;
      setStatus("هذا المتصفح لا يدعم التعرف الصوتي المجاني. جرّب Chrome على Android/Windows أو Safari حديث على iPhone.");
      return;
    }

    // Important for iPhone: start recognition synchronously from the button
    // tap. Do not await/setTimeout here or WebKit may treat it as lacking a
    // fresh user gesture and return not-allowed even when permission is granted.
    recognitionSessionRef.current += 1;
    const sessionId = recognitionSessionRef.current;
    const oldRecognition = recognitionRef.current;
    recognitionRef.current = null;
    if (oldRecognition) {
      try { oldRecognition.onend = null; } catch {}
      try { oldRecognition.onerror = null; } catch {}
      try { oldRecognition.abort(); } catch {}
    }

    setRecording(true);
    setStatus("عم اسمعك… بلّش القراءة مباشرة 🎙️");
    launchRecognition(sessionId);
  }

  function stopRecognition(analyze: boolean) {
    keepListeningRef.current = false;
    shouldAnalyzeRef.current = analyze;

    if (analyze) {
      setBusy(true);
      setStatus("عم قارن القراءة مع الآية على الجهاز…");
    }

    const recognition = recognitionRef.current;
    if (!recognition) {
      setRecording(false);
      if (analyze) {
        shouldAnalyzeRef.current = false;
        finishAnalysis(finalTranscriptRef.current || latestTranscriptRef.current);
      }
      return;
    }

    try {
      recognition.stop();
    } catch {
      recognitionRef.current = null;
      setRecording(false);
      if (analyze) {
        shouldAnalyzeRef.current = false;
        finishAnalysis(finalTranscriptRef.current || latestTranscriptRef.current);
      }
    }
  }

  function stopRecording() {
    stopRecognition(true);
  }

  return (
    <main>
      <section className="hero">
        <h1>مدرّب التلاوة 🌙</h1>
        <p>اقرأ الآية وخذ ملاحظة على الكلمات التي تحتاج إعادة. هذا الوضع لا يستخدم Gemini أو OpenAI ولا يحتاج بطاقة دفع.</p>
        {installPrompt && (
          <div className="controls">
            <button className="secondary" onClick={installApp}>📲 ثبّت التطبيق على الموبايل</button>
          </div>
        )}
      </section>

      <div className="grid two">
        <section className="card">
          <div className="label">من عم يقرأ؟</div>
          <div className="profileRow">
            {PROFILES.map((p) => (
              <button key={p} className={`chip ${profile === p ? "active" : ""}`} onClick={() => chooseProfile(p)}>{p}</button>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="label">اختر السورة</div>
          <select value={surahNo} onChange={(e) => chooseSurah(Number(e.target.value))}>
            {surahs.map((s) => <option value={s.number} key={s.number}>سورة {s.name}</option>)}
          </select>

          <div className="label" style={{ marginTop: 12 }}>اختر الآية</div>
          <select
            value={ayahNo}
            onChange={(e) => {
              stopRecognition(false);
              stopWordAudio();
              stopAyahAudio();
              setAyahNo(Number(e.target.value));
              setAnalysis(null);
              setLiveTranscript("");
              setStatus("اضغط على الميكروفون واقرأ الآية كاملة.");
            }}
          >
            {surah.ayahs.map((a) => <option value={a.number} key={a.number}>الآية {a.number}</option>)}
          </select>
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="label">سورة {surah.name} — الآية {ayah.number}</div>
        <div className="ayahText">{ayah.text}</div>

        <div className="controls">
          <button
            type="button"
            className="tajweedListen"
            onClick={() => playAyahWithTajweed().catch((error) => {
              console.error(error);
              setStatus("ما قدرت شغّل تلاوة الآية. جرّب مرة ثانية وتأكد من اتصال الإنترنت.");
            })}
          >
            {playingAyah ? "🕌 عم يقرأ الآية…" : "🕌 اسمع الآية بتجويد"}
          </button>
        </div>

        <div className="controls">
          {!recording ? (
            <button className="primary" onClick={startRecording} disabled={busy || !speechSupported}>🎙️ ابدأ القراءة</button>
          ) : (
            <button className="danger" onClick={stopRecording}>⏹️ انتهيت</button>
          )}
        </div>

        {!speechSupported && (
          <div className="status error">المتصفح الحالي لا يدعم SpeechRecognition. افتح التطبيق بمتصفح يدعم التعرف الصوتي.</div>
        )}

        {liveTranscript && recording && <div className="small">ما يسمعه المتصفح الآن: {liveTranscript}</div>}
        <div className="status info">{busy ? "عم قارن القراءة مع الآية…" : status}</div>

        {analysis && (
          <div className="result">
            <div className="score">النتيجة: {analysis.score}%</div>
            <div className="small">ما سمعه المتصفح: {analysis.transcript || "—"}</div>
            <div className="words">
              {wordsWithPositions.map((w) => (
                <div className="wordResult" key={`${w.expected}-${w.resultIndex}`}>
                  <span className={`word ${w.status}`} title={w.heard ? `سمع: ${w.heard}` : undefined}>
                    {w.expected}
                  </span>
                  {(w.status === "wrong" || w.status === "missing") && w.quranPosition !== null && (
                    <>
                      <button
                        type="button"
                        className="wordListen"
                        onClick={() => playWord(w.quranPosition!).catch((error) => {
                          console.error(error);
                          setStatus("ما قدرت شغّل نطق الكلمة. جرّب مرة ثانية وتأكد من اتصال الإنترنت.");
                        })}
                        disabled={playingAllMistakes || playingAyah}
                        aria-label={`اسمع النطق الصحيح لكلمة ${w.expected}`}
                      >
                        {playingWordPosition === w.quranPosition ? "🔊 عم يقرأ…" : "🔊 اسمع الكلمة"}
                      </button>
                      <button
                        type="button"
                        className="wordListen contextual"
                        onClick={() => playAyahWithTajweed().catch((error) => {
                          console.error(error);
                          setStatus("ما قدرت شغّل تلاوة الآية. جرّب مرة ثانية وتأكد من اتصال الإنترنت.");
                        })}
                        disabled={playingAllMistakes || playingAyah}
                        aria-label={`اسمع كلمة ${w.expected} ضمن تلاوة الآية`}
                      >
                        🕌 اسمعها ضمن الآية
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>

            {wordsWithPositions.some((w) => w.status === "wrong" || w.status === "missing") && (
              <div className="controls">
                <button type="button" className="secondary" onClick={hearAllMistakes} disabled={playingAllMistakes}>
                  {playingAllMistakes ? "🔊 عم يقرأ الكلمات…" : "🔊 اسمع كل الكلمات التي تحتاج إعادة"}
                </button>
              </div>
            )}
            {analysis.warning && <div className="status error">{analysis.warning}</div>}
          </div>
        )}
      </section>

      <div className="notice">
        ✅ الوضع الحالي بلا Gemini/OpenAI ولا يحتاج API key أو بطاقة. التعرف على الكلام يتم عبر ميزة المتصفح وقد يعتمد المتصفح نفسه على خدمة صوتية خارجية. ⚠️ على iPhone يوجد خلل معروف في WebKit مع إعادة تشغيل SpeechRecognition، لذلك ابدأ القراءة مباشرة بعد الضغط على زر الميكروفون. هذا ليس فحص تجويد دقيقًا للمخارج والمدود والغنة.
      </div>
    </main>
  );
}

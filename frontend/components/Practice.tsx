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

function preferredAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }

  const candidates = [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

async function decodeAndResampleTo16k(blob: Blob): Promise<Float32Array> {
  const encoded = await blob.arrayBuffer();
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("AudioContext is not supported on this device.");

  const context = new AudioContextCtor();
  try {
    const decoded = await context.decodeAudioData(encoded.slice(0));
    if (!decoded.duration || decoded.duration < 0.15) {
      throw new Error("Recording is too short.");
    }

    const targetRate = 16000;
    const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, targetLength, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();

    // Copy the channel so the returned Float32Array owns a transferable buffer.
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    await context.close().catch(() => {});
  }
}

export default function Practice() {
  const [profile, setProfile] = useState("أنا");
  const [surahNo, setSurahNo] = useState(1);
  const [ayahNo, setAyahNo] = useState(1);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("اضغط على الميكروفون واقرأ الآية كاملة.");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [recorderSupported, setRecorderSupported] = useState(true);
  const [modelReady, setModelReady] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelProgress, setModelProgress] = useState<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const discardRecordingRef = useRef(false);
  const workerRef = useRef<Worker | null>(null);
  const pendingAudioRef = useRef<Float32Array | null>(null);
  const attemptContextRef = useRef<{
    profile: string;
    surahNo: number;
    ayahNo: number;
    expectedText: string;
  } | null>(null);

  // The Whisper worker listener is created once. Keep the latest UI selection in
  // a ref so async results are compared with the current ayah/profile instead of
  // the values captured by the first React render.
  const currentSelectionRef = useRef({ profile, surahNo, ayahNo });

  const wordAudio = useRef<HTMLAudioElement | null>(null);
  const ayahAudio = useRef<HTMLAudioElement | null>(null);
  const [playingWordPosition, setPlayingWordPosition] = useState<number | null>(null);
  const [playingAllMistakes, setPlayingAllMistakes] = useState(false);
  const [playingAyah, setPlayingAyah] = useState(false);

  const surah = useMemo(() => surahs.find((s) => s.number === surahNo) ?? surahs[0], [surahNo]);
  const ayah = useMemo(() => surah.ayahs.find((a) => a.number === ayahNo) ?? surah.ayahs[0], [surah, ayahNo]);

  useEffect(() => {
    currentSelectionRef.current = { profile, surahNo, ayahNo };
  }, [profile, surahNo, ayahNo]);

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

    setRecorderSupported(
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined"
    );

    const worker = new Worker(new URL("../workers/quran.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data ?? {};

      if (message.type === "model-loading") {
        setModelLoading(true);
        setStatus("أول مرة فقط: عم نزّل محرك التعرّف القرآني على الجهاز (~104 MB)…");
        return;
      }

      if (message.type === "model-progress") {
        const progress = typeof message.progress === "number" ? message.progress : null;
        if (progress !== null && Number.isFinite(progress)) {
          const normalized = progress <= 1 ? progress * 100 : progress;
          setModelProgress(Math.max(0, Math.min(100, Math.round(normalized))));
        }
        return;
      }

      if (message.type === "model-ready") {
        setModelReady(true);
        setModelLoading(false);
        setModelProgress(100);
        if (!busy && !recording) setStatus("محرك التصحيح جاهز ✅");
        return;
      }

      if (message.type === "transcribing") {
        setBusy(true);
        setStatus("عم حلّل التلاوة بالמודيل القرآني على جهازك…");
        return;
      }

      if (message.type === "result") {
        const transcript = String(message.text ?? "").trim();
        pendingAudioRef.current = null;
        finishAnalysis(transcript);
        return;
      }

      if (message.type === "error") {
        console.error("Local Quran ASR error", message.message);
        pendingAudioRef.current = null;
        setBusy(false);
        setModelLoading(false);
        setStatus("صار خطأ أثناء التحليل القرآني المحلي. إذا كانت أول مرة، تأكد أن الإنترنت شغال حتى ينزل الموديل، وبعدها جرّب مرة ثانية.");
      }
    };

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler as EventListener);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

    return () => {
      window.removeEventListener("beforeinstallprompt", handler as EventListener);
      worker.terminate();
      workerRef.current = null;
      cleanupRecorder(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function chooseProfile(name: string) {
    setProfile(name);
    localStorage.setItem("quran-coach-profile", name);
  }

  function chooseSurah(nextSurahNo: number) {
    cleanupRecorder(true);
    stopWordAudio();
    stopAyahAudio();
    setSurahNo(nextSurahNo);
    setAyahNo(1);
    attemptContextRef.current = null;
    setAnalysis(null);
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
    cleanupRecorder(true);
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
    cleanupRecorder(true);
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
    const cleanTranscript = transcript.trim();
    const attempt = attemptContextRef.current;
    attemptContextRef.current = null;

    if (!attempt) {
      // The user changed surah/ayah or cancelled while Whisper was working.
      setBusy(false);
      return;
    }

    // Never show an old result under a newly selected ayah. Use the latest
    // selection ref here because this callback is invoked asynchronously by a
    // worker whose listener was registered on the first render.
    const current = currentSelectionRef.current;
    if (
      attempt.surahNo !== current.surahNo ||
      attempt.ayahNo !== current.ayahNo ||
      attempt.profile !== current.profile
    ) {
      setBusy(false);
      setStatus("تم تجاهل نتيجة قديمة لأنك غيّرت السورة أو الآية.");
      return;
    }

    if (!cleanTranscript) {
      setAnalysis(null);
      setStatus("الموديل القرآني ما التقط كلمات واضحة. قرّب الموبايل، ارفع صوتك شوي، وجرب مرة ثانية.");
      setBusy(false);
      return;
    }

    const result = analyzeTranscript(attempt.expectedText, cleanTranscript);
    setAnalysis(result);
    setStatus(result.feedback);
    localStorage.setItem(
      `progress-${attempt.profile}-${attempt.surahNo}-${attempt.ayahNo}`,
      JSON.stringify({ score: result.score, at: new Date().toISOString() })
    );
    setBusy(false);
  }

  function releaseStream() {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) track.stop();
      mediaStreamRef.current = null;
    }
  }

  function cleanupRecorder(discard: boolean) {
    discardRecordingRef.current = discard;
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;

    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch {}
    }

    releaseStream();
    if (discard) chunksRef.current = [];
    setRecording(false);
  }

  async function sendRecordingForAnalysis(blob: Blob) {
    try {
      setBusy(true);
      setStatus(modelReady ? "عم حضّر الصوت للتحليل القرآني…" : "عم حضّر الصوت، وأول مرة رح ينزل الموديل القرآني…");

      const audio = await decodeAndResampleTo16k(blob);
      // blob and encoded bytes are now eligible for garbage collection. Only the
      // model remains cached by Transformers.js; recordings are not persisted.
      pendingAudioRef.current = audio;
      const buffer = audio.buffer;
      workerRef.current?.postMessage({ type: "transcribe", audio: buffer }, [buffer]);
    } catch (error) {
      console.error("Could not prepare recording", error);
      pendingAudioRef.current = null;
      setBusy(false);
      setStatus("ما قدرت أقرأ ملف التسجيل على هالجهاز. جرّب مرة ثانية.");
    }
  }

  async function startRecording() {
    if (recording || busy) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecorderSupported(false);
      setStatus("هذا الجهاز ما بيدعم التسجيل المطلوب. جرّب Safari أو Chrome حديث.");
      return;
    }

    stopWordAudio();
    stopAyahAudio();
    setAnalysis(null);
    discardRecordingRef.current = false;
    chunksRef.current = [];
    attemptContextRef.current = {
      profile,
      surahNo: surah.number,
      ayahNo: ayah.number,
      expectedText: ayah.simpleText,
    };

    try {
      setStatus("عم افتح الميكروفون…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const mimeType = preferredAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };

      recorder.onerror = (event) => {
        console.error("MediaRecorder error", event);
        setStatus("صار خطأ بالتسجيل. جرّب مرة ثانية.");
        cleanupRecorder(true);
      };

      recorder.onstop = () => {
        const discard = discardRecordingRef.current;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        releaseStream();
        setRecording(false);

        if (discard || chunks.length === 0) return;

        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        void sendRecordingForAnalysis(blob);
      };

      // Warm up/download the Quran-specific FastConformer while the user is reading.
      // The model/assets are cached in browser Cache Storage for later attempts.
      if (!modelReady && !modelLoading) workerRef.current?.postMessage({ type: "load" });

      recorder.start(250);
      setRecording(true);
      setStatus("عم سجّل… اقرأ الآية، ولما تخلص اضغط «انتهيت» 🎙️");
    } catch (error: any) {
      console.error("Could not access microphone", error);
      releaseStream();
      attemptContextRef.current = null;
      setRecording(false);
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        setStatus("المتصفح ما أعطى إذن للميكروفون. افتح إعدادات الموقع واسمح بالميكروفون ثم جرّب مرة ثانية.");
      } else {
        setStatus("ما قدرت افتح الميكروفون. جرّب إغلاق أي تطبيق ثاني يستخدم المايك ثم أعد المحاولة.");
      }
    }
  }

  function stopRecording() {
    if (!recording) return;
    discardRecordingRef.current = false;
    setStatus("تم التسجيل. عم جهّز القراءة للتحليل…");
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch {
        cleanupRecorder(true);
        setStatus("ما قدرت أنهي التسجيل بشكل صحيح. جرّب مرة ثانية.");
      }
    }
  }

  return (
    <main>
      <section className="hero">
        <h1>مدرّب التلاوة 🌙</h1>
        <p>سجّل الآية، والموديل القرآني FastConformer يحللها محليًا على جهازك. ما في Gemini أو OpenAI API، والتسجيل نفسه ما بينحفظ.</p>
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
              cleanupRecorder(true);
              stopWordAudio();
              stopAyahAudio();
              setAyahNo(Number(e.target.value));
              attemptContextRef.current = null;
              setAnalysis(null);
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
            <button className="primary" onClick={startRecording} disabled={busy || !recorderSupported}>🎙️ ابدأ القراءة</button>
          ) : (
            <button className="danger" onClick={stopRecording}>⏹️ انتهيت</button>
          )}
        </div>

        {!recorderSupported && (
          <div className="status error">المتصفح الحالي ما بيدعم MediaRecorder. افتح التطبيق على Safari أو Chrome حديث.</div>
        )}

        {(modelLoading || (busy && !modelReady)) && (
          <div className="status info">
            أول استخدام فقط: عم يجهّز موديل القرآن على الجهاز
            {modelProgress !== null ? ` — ${modelProgress}%` : "…"}
          </div>
        )}

        <div className="status info">{status}</div>

        {analysis && (
          <div className="result">
            <div className="score">النتيجة: {analysis.score}%</div>
            <div className="small">ما التقطه الموديل القرآني: {analysis.transcript || "—"}</div>
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
        ✅ مجاني بالكامل: التسجيل مؤقت ولا يُحفظ. موديل القرآن وملفاته فقط تُخزّن في كاش المتصفح بعد أول تحميل. ⚠️ هذا الإصدار يصحح الكلمات باستخدام موديل مخصص لتلاوة القرآن؛ تقييم المخارج والمد والغنة بدقة سيكون مرحلة منفصلة.
      </div>
    </main>
  );
}

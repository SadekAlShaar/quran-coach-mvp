"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { surahs } from "@/lib/surahs";
import { analyzeTranscript, type LocalAnalysis, type WordResult } from "@/lib/localAnalysis";
import { deleteLastRecording, getLastRecording, saveLastRecording } from "@/lib/recordingStorage";

type Analysis = LocalAnalysis;

type PositionedWord = WordResult & {
  resultIndex: number;
  quranPosition: number | null;
};

type AttemptContext =
  | {
      mode: "ayah";
      profile: string;
      surahNo: number;
      ayahNo: number;
      expectedText: string;
    }
  | {
      mode: "word";
      profile: string;
      surahNo: number;
      ayahNo: number;
      expectedText: string;
      resultIndex: number;
      quranPosition: number | null;
    };

type WordRetryFeedback = {
  correct: boolean;
  heard: string;
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
  const [recordingMode, setRecordingMode] = useState<"ayah" | "word" | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("اضغط على الميكروفون واقرأ الآية كاملة.");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [recorderSupported, setRecorderSupported] = useState(true);
  const [modelReady, setModelReady] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const [wordRetryTarget, setWordRetryTarget] = useState<{
    resultIndex: number;
    expected: string;
    quranPosition: number | null;
  } | null>(null);
  const [wordRetryFeedback, setWordRetryFeedback] = useState<Record<number, WordRetryFeedback>>({});

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const discardRecordingRef = useRef(false);
  const workerRef = useRef<Worker | null>(null);
  const pendingAudioRef = useRef<Float32Array | null>(null);
  const attemptContextRef = useRef<AttemptContext | null>(null);

  // The Quran ASR worker listener is created once. Keep the latest UI selection in
  // a ref so async results are compared with the current ayah/profile instead of
  // the values captured by the first React render.
  const currentSelectionRef = useRef({ profile, surahNo, ayahNo });

  const wordAudio = useRef<HTMLAudioElement | null>(null);
  const ayahAudio = useRef<HTMLAudioElement | null>(null);
  const [playingWordPosition, setPlayingWordPosition] = useState<number | null>(null);
  const [playingAllMistakes, setPlayingAllMistakes] = useState(false);
  const [playingAyah, setPlayingAyah] = useState(false);
  const [hasSavedRecording, setHasSavedRecording] = useState(false);
  const [savedRecordingAt, setSavedRecordingAt] = useState<string | null>(null);
  const [playingSavedRecording, setPlayingSavedRecording] = useState(false);
  const savedRecordingAudioRef = useRef<HTMLAudioElement | null>(null);
  const savedRecordingUrlRef = useRef<string | null>(null);

  const surah = useMemo(() => surahs.find((s) => s.number === surahNo) ?? surahs[0], [surahNo]);
  const ayah = useMemo(() => surah.ayahs.find((a) => a.number === ayahNo) ?? surah.ayahs[0], [surah, ayahNo]);

  useEffect(() => {
    currentSelectionRef.current = { profile, surahNo, ayahNo };
  }, [profile, surahNo, ayahNo]);

  useEffect(() => {
    let cancelled = false;
    void getLastRecording(profile, surahNo, ayahNo)
      .then((saved) => {
        if (cancelled) return;
        setHasSavedRecording(Boolean(saved));
        setSavedRecordingAt(saved?.createdAt ?? null);
      })
      .catch((error) => {
        console.error("Could not check saved recording", error);
        if (!cancelled) {
          setHasSavedRecording(false);
          setSavedRecordingAt(null);
        }
      });
    return () => { cancelled = true; };
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
        const attempt = attemptContextRef.current;
        setStatus(
          attempt?.mode === "word"
            ? `عم حلّل كلمة «${attempt.expectedText}» على جهازك…`
            : "عم حلّل التلاوة بالموديل القرآني على جهازك…"
        );
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
        attemptContextRef.current = null;
        setWordRetryTarget(null);
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
      stopSavedRecording();
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
    stopSavedRecording();
    setSurahNo(nextSurahNo);
    setAyahNo(1);
    attemptContextRef.current = null;
    setAnalysis(null);
    setWordRetryTarget(null);
    setWordRetryFeedback({});
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
    return `https://everyayah.com/data/Ayman_Sowaid_64kbps/${chapter}${verse}.mp3`;
  }

  function stopSavedRecording() {
    if (savedRecordingAudioRef.current) {
      savedRecordingAudioRef.current.pause();
      savedRecordingAudioRef.current.currentTime = 0;
      savedRecordingAudioRef.current = null;
    }
    if (savedRecordingUrlRef.current) {
      URL.revokeObjectURL(savedRecordingUrlRef.current);
      savedRecordingUrlRef.current = null;
    }
    setPlayingSavedRecording(false);
  }

  async function playSavedRecording() {
    if (recording || busy) return;
    stopWordAudio();
    stopAyahAudio();
    stopSavedRecording();

    try {
      const saved = await getLastRecording(profile, surah.number, ayah.number);
      if (!saved) {
        setHasSavedRecording(false);
        setSavedRecordingAt(null);
        setStatus("ما في تسجيل محفوظ لهالآية بعد.");
        return;
      }

      const url = URL.createObjectURL(saved.blob);
      savedRecordingUrlRef.current = url;
      const player = new Audio(url);
      savedRecordingAudioRef.current = player;
      setPlayingSavedRecording(true);

      await new Promise<void>((resolve, reject) => {
        player.onended = () => resolve();
        player.onerror = () => reject(new Error("Could not play saved recording."));
        player.play().catch(reject);
      });
    } catch (error) {
      console.error("Could not play saved recording", error);
      setStatus("ما قدرت شغّل التسجيل المحفوظ. جرّب مرة ثانية.");
    } finally {
      stopSavedRecording();
    }
  }

  async function removeSavedRecording() {
    stopSavedRecording();
    try {
      await deleteLastRecording(profile, surah.number, ayah.number);
      setHasSavedRecording(false);
      setSavedRecordingAt(null);
      setStatus("تم حذف آخر تسجيل لهالآية من هذا الجهاز.");
    } catch (error) {
      console.error("Could not delete saved recording", error);
      setStatus("ما قدرت احذف التسجيل المحفوظ.");
    }
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
      setBusy(false);
      setWordRetryTarget(null);
      return;
    }

    const current = currentSelectionRef.current;
    if (
      attempt.surahNo !== current.surahNo ||
      attempt.ayahNo !== current.ayahNo ||
      attempt.profile !== current.profile
    ) {
      setBusy(false);
      setWordRetryTarget(null);
      setStatus("تم تجاهل نتيجة قديمة لأنك غيّرت السورة أو الآية.");
      return;
    }

    if (!cleanTranscript) {
      if (attempt.mode === "ayah") setAnalysis(null);
      setStatus(
        attempt.mode === "word"
          ? `الموديل ما التقط كلمة «${attempt.expectedText}» بوضوح. قرّب الموبايل وجرّب مرة ثانية.`
          : "الموديل القرآني ما التقط كلمات واضحة. قرّب الموبايل، ارفع صوتك شوي، وجرب مرة ثانية."
      );
      setBusy(false);
      setWordRetryTarget(null);
      return;
    }

    if (attempt.mode === "word") {
      const retryResult = analyzeTranscript(attempt.expectedText, cleanTranscript);
      const correct = retryResult.score === 100 && retryResult.words.every((word) => word.status === "correct");

      setWordRetryFeedback((previous) => ({
        ...previous,
        [attempt.resultIndex]: { correct, heard: cleanTranscript },
      }));

      if (correct) {
        setAnalysis((previous) => {
          if (!previous) return previous;
          const words = previous.words.map((word, index) =>
            index === attempt.resultIndex
              ? { ...word, status: "correct" as const, heard: cleanTranscript }
              : word
          );
          const correctCount = words.filter((word) => word.status === "correct").length;
          const score = Math.round((correctCount / Math.max(words.length, 1)) * 100);
          const mistakes = words.filter((word) => word.status !== "correct").length;
          return {
            ...previous,
            words,
            score,
            feedback:
              mistakes === 0
                ? "ممتاز! صححت كل الكلمات التي كانت تحتاج إعادة ✅"
                : `ممتاز، صححت الكلمة ✅ بقي ${mistakes} موضع يحتاج إعادة.`,
          };
        });
        setStatus(`✅ ممتاز! كلمة «${attempt.expectedText}» صارت صحيحة.`);
      } else {
        setStatus(`لسا كلمة «${attempt.expectedText}» بدها إعادة. الموديل التقط: «${cleanTranscript}». اسمعها وحاول مرة ثانية.`);
      }

      setBusy(false);
      setWordRetryTarget(null);
      return;
    }

    const result = analyzeTranscript(attempt.expectedText, cleanTranscript);
    setAnalysis(result);
    setWordRetryFeedback({});
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
    if (discard) {
      chunksRef.current = [];
      attemptContextRef.current = null;
      setWordRetryTarget(null);
    }
    setRecording(false);
    setRecordingMode(null);
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

  async function beginRecording(attempt: AttemptContext, clearCurrentAnalysis: boolean) {
    if (recording || busy) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecorderSupported(false);
      setStatus("هذا الجهاز ما بيدعم التسجيل المطلوب. جرّب Safari أو Chrome حديث.");
      return;
    }

    stopWordAudio();
    stopAyahAudio();
    stopSavedRecording();
    if (clearCurrentAnalysis) {
      setAnalysis(null);
      setWordRetryFeedback({});
    }
    discardRecordingRef.current = false;
    chunksRef.current = [];
    attemptContextRef.current = attempt;
    setRecordingMode(attempt.mode);
    setWordRetryTarget(
      attempt.mode === "word"
        ? {
            resultIndex: attempt.resultIndex,
            expected: attempt.expectedText,
            quranPosition: attempt.quranPosition,
          }
        : null
    );

    try {
      setStatus(
        attempt.mode === "word"
          ? `عم افتح الميكروفون لإعادة كلمة «${attempt.expectedText}»…`
          : "عم افتح الميكروفون…"
      );
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
        setRecordingMode(null);

        if (discard || chunks.length === 0) return;

        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        const currentAttempt = attemptContextRef.current;

        // Only a full-ayah attempt becomes the saved "last recording".
        // Word retries are temporary and disappear after analysis.
        if (currentAttempt?.mode === "ayah") {
          void saveLastRecording(
            currentAttempt.profile,
            currentAttempt.surahNo,
            currentAttempt.ayahNo,
            blob
          )
            .then((createdAt) => {
              const current = currentSelectionRef.current;
              if (
                current.profile === currentAttempt.profile &&
                current.surahNo === currentAttempt.surahNo &&
                current.ayahNo === currentAttempt.ayahNo
              ) {
                setHasSavedRecording(true);
                setSavedRecordingAt(createdAt);
              }
            })
            .catch((error) => console.error("Could not save last recording", error));
        }

        void sendRecordingForAnalysis(blob);
      };

      if (!modelReady && !modelLoading) workerRef.current?.postMessage({ type: "load" });

      recorder.start(250);
      setRecording(true);
      setStatus(
        attempt.mode === "word"
          ? `🎙️ قل كلمة «${attempt.expectedText}» فقط، ثم اضغط «انتهيت».`
          : "عم سجّل… اقرأ الآية، ولما تخلص اضغط «انتهيت» 🎙️"
      );
    } catch (error: any) {
      console.error("Could not access microphone", error);
      releaseStream();
      attemptContextRef.current = null;
      setWordRetryTarget(null);
      setRecording(false);
      setRecordingMode(null);
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        setStatus("المتصفح ما أعطى إذن للميكروفون. افتح إعدادات الموقع واسمح بالميكروفون ثم جرّب مرة ثانية.");
      } else {
        setStatus("ما قدرت افتح الميكروفون. جرّب إغلاق أي تطبيق ثاني يستخدم المايك ثم أعد المحاولة.");
      }
    }
  }

  async function startRecording() {
    await beginRecording(
      {
        mode: "ayah",
        profile,
        surahNo: surah.number,
        ayahNo: ayah.number,
        expectedText: ayah.simpleText,
      },
      true
    );
  }

  async function startWordRetry(word: PositionedWord) {
    if (word.status !== "wrong" && word.status !== "missing") return;
    await beginRecording(
      {
        mode: "word",
        profile,
        surahNo: surah.number,
        ayahNo: ayah.number,
        expectedText: word.expected,
        resultIndex: word.resultIndex,
        quranPosition: word.quranPosition,
      },
      false
    );
  }

  function stopRecording() {
    if (!recording) return;
    discardRecordingRef.current = false;
    const attempt = attemptContextRef.current;
    setStatus(
      attempt?.mode === "word"
        ? "تم تسجيل الكلمة. عم جهّزها للتحليل…"
        : "تم التسجيل. عم جهّز القراءة للتحليل…"
    );
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
        <p>سجّل الآية، والموديل القرآني FastConformer يحللها محليًا على جهازك. إذا ظهرت كلمة غلط، اسمعها وأعد نفس الكلمة فقط حتى تصير خضراء. ما في Gemini أو OpenAI API.</p>
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
              stopSavedRecording();
              setAyahNo(Number(e.target.value));
              attemptContextRef.current = null;
              setAnalysis(null);
              setWordRetryTarget(null);
              setWordRetryFeedback({});
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
            {playingAyah ? "🕌 الشيخ أيمن سويد يقرأ…" : "🕌 اسمع الآية — أيمن سويد"}
          </button>
        </div>

        <div className="controls">
          {recordingMode === "ayah" ? (
            <button className="danger" onClick={stopRecording}>⏹️ انتهيت</button>
          ) : (
            <button
              className="primary"
              onClick={startRecording}
              disabled={busy || recording || !recorderSupported}
            >
              🎙️ ابدأ قراءة الآية
            </button>
          )}
        </div>

        {hasSavedRecording && (
          <div className="controls">
            <button
              type="button"
              className="secondary"
              onClick={playSavedRecording}
              disabled={recording || busy || playingSavedRecording}
            >
              {playingSavedRecording ? "▶️ عم شغّل تسجيلك…" : "▶️ اسمع آخر تسجيل"}
            </button>
            <button
              type="button"
              className="danger"
              onClick={removeSavedRecording}
              disabled={recording || busy || playingSavedRecording}
            >
              🗑️ احذف التسجيل
            </button>
            {savedRecordingAt && (
              <div className="small">آخر تسجيل محفوظ على هذا الجهاز: {new Date(savedRecordingAt).toLocaleString("ar")}</div>
            )}
          </div>
        )}

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
                        disabled={playingAllMistakes || playingAyah || recording || busy}
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
                        disabled={playingAllMistakes || playingAyah || recording || busy}
                        aria-label={`اسمع كلمة ${w.expected} ضمن تلاوة الآية`}
                      >
                        🕌 اسمعها ضمن الآية
                      </button>
                      <button
                        type="button"
                        className={
                          recordingMode === "word" && wordRetryTarget?.resultIndex === w.resultIndex
                            ? "danger"
                            : "wordListen"
                        }
                        onClick={() => {
                          if (recordingMode === "word" && wordRetryTarget?.resultIndex === w.resultIndex) {
                            stopRecording();
                          } else {
                            void startWordRetry(w);
                          }
                        }}
                        disabled={
                          busy ||
                          playingAllMistakes ||
                          playingAyah ||
                          (recording && wordRetryTarget?.resultIndex !== w.resultIndex)
                        }
                        aria-label={`أعد قراءة كلمة ${w.expected}`}
                      >
                        {recordingMode === "word" && wordRetryTarget?.resultIndex === w.resultIndex
                          ? "⏹️ انتهيت"
                          : "🎙️ أعد الكلمة"}
                      </button>
                    </>
                  )}
                  {wordRetryFeedback[w.resultIndex] && (
                    <div className="small">
                      {wordRetryFeedback[w.resultIndex].correct
                        ? `✅ ممتاز — «${w.expected}» صارت صحيحة.`
                        : `❌ الموديل التقط: «${wordRetryFeedback[w.resultIndex].heard}» — حاول مرة ثانية.`}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {wordsWithPositions.some((w) => w.status === "wrong" || w.status === "missing") && (
              <div className="controls">
                <button type="button" className="secondary" onClick={hearAllMistakes} disabled={playingAllMistakes || recording || busy}>
                  {playingAllMistakes ? "🔊 عم يقرأ الكلمات…" : "🔊 اسمع كل الكلمات التي تحتاج إعادة"}
                </button>
              </div>
            )}
            {analysis.warning && <div className="status error">{analysis.warning}</div>}
          </div>
        )}
      </section>

      <div className="notice">
        ✅ مجاني بالكامل: التحليل يتم على الجهاز. إعادة الكلمات الغلط تُحلَّل مؤقتًا ولا تُحفظ؛ نحفظ فقط آخر تسجيل كامل لكل آية ولكل شخص على هذا الجهاز. ⚠️ تقييم المخارج والمد والغنة بدقة سيكون مرحلة منفصلة.
      </div>
    </main>
  );
}

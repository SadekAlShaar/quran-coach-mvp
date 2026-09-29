"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { surahs } from "@/lib/surahs";

type WordResult = { expected: string; heard?: string | null; status: "correct" | "wrong" | "missing" | "extra" };
type Analysis = {
  mode: string;
  transcript: string;
  score: number;
  words: WordResult[];
  feedback: string;
  warning?: string | null;
};

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const PROFILES = ["أبي", "أمي", "أنا"];

export default function Practice() {
  const [profile, setProfile] = useState("أنا");
  const [surahNo, setSurahNo] = useState(1);
  const [ayahNo, setAyahNo] = useState(1);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("اضغط على الميكروفون واقرأ الآية كاملة.");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const wordAudio = useRef<HTMLAudioElement | null>(null);
  const [playingWordPosition, setPlayingWordPosition] = useState<number | null>(null);
  const [playingAllMistakes, setPlayingAllMistakes] = useState(false);

  const surah = useMemo(() => surahs.find((s) => s.number === surahNo) ?? surahs[0], [surahNo]);
  const ayah = useMemo(() => surah.ayahs.find((a) => a.number === ayahNo) ?? surah.ayahs[0], [surah, ayahNo]);

  const wordsWithPositions = useMemo(() => {
    if (!analysis) return [];
    let quranPosition = 0;
    return analysis.words.map((word, resultIndex) => {
      // An "extra" word was spoken by the learner and does not consume a Quran word position.
      // Every other status corresponds to the next expected word in the ayah.
      if (word.status !== "extra") quranPosition += 1;
      return {
        ...word,
        resultIndex,
        quranPosition: word.status === "extra" ? null : quranPosition,
      };
    });
  }, [analysis]);

  function quranWordAudioUrl(position: number) {
    const chapter = String(surah.number).padStart(3, "0");
    const verse = String(ayah.number).padStart(3, "0");
    const word = String(position).padStart(3, "0");
    return `https://audio.qurancdn.com/wbw/${chapter}_${verse}_${word}.mp3`;
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
    stopWordAudio();
    setPlayingWordPosition(position);
    const player = new Audio(quranWordAudioUrl(position));
    wordAudio.current = player;

    await new Promise<void>((resolve, reject) => {
      player.onended = () => resolve();
      player.onerror = () => reject(new Error("Could not load Quran word audio"));
      player.play().catch(reject);
    }).finally(() => {
      if (wordAudio.current === player) wordAudio.current = null;
      setPlayingWordPosition((current) => current === position ? null : current);
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

  useEffect(() => {
    const saved = localStorage.getItem("quran-coach-profile");
    if (saved) setProfile(saved);
    const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener("beforeinstallprompt", handler as EventListener);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => window.removeEventListener("beforeinstallprompt", handler as EventListener);
  }, []);

  function chooseProfile(name: string) {
    setProfile(name);
    localStorage.setItem("quran-coach-profile", name);
  }

  function chooseSurah(nextSurahNo: number) {
    stopWordAudio();
    setSurahNo(nextSurahNo);
    setAyahNo(1);
    setAnalysis(null);
    setAudioUrl(null);
    setStatus("اضغط على الميكروفون واقرأ الآية كاملة.");
  }

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
  }

  async function startRecording() {
    setAnalysis(null);
    setStatus("عم اسمعك… اقرأ بهدوء وبصوت واضح 🎙️");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      const preferred = candidates.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      chunks.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: recorder.mimeType || "audio/webm" });
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioUrl(URL.createObjectURL(blob));
        await analyze(blob, recorder.mimeType || blob.type || "audio/webm");
      };
      mediaRecorder.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setStatus("ما قدرت أوصل للميكروفون. اسمح للتطبيق باستخدام الميكروفون من إعدادات المتصفح.");
    }
  }

  function stopRecording() {
    if (!mediaRecorder.current || mediaRecorder.current.state === "inactive") return;
    setRecording(false);
    setStatus("عم حلّل القراءة…");
    mediaRecorder.current.stop();
  }

  async function analyze(blob: Blob, mimeType: string) {
    setBusy(true);
    try {
      const data = new FormData();
      const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
      data.append("audio", blob, `recitation.${extension}`);
      data.append("surah", String(surah.number));
      data.append("ayah", String(ayah.number));
      data.append("expected_text", ayah.simpleText);
      data.append("profile", profile);

      const res = await fetch(`${API}/analyze`, { method: "POST", body: data });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setAnalysis(json);
      setStatus(json.feedback);
      localStorage.setItem(
        `progress-${profile}-${surah.number}-${ayah.number}`,
        JSON.stringify({ score: json.score, at: new Date().toISOString() })
      );
    } catch (e) {
      console.error(e);
      setStatus("صار خطأ أثناء التحليل. تأكد أن الـBackend شغّال وأن عنوان الـAPI صحيح.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="hero">
        <h1>مدرّب التلاوة 🌙</h1>
        <p>اقرأ الآية، وخذ ملاحظة آلية تساعدك على اكتشاف الكلمات التي تحتاج إعادة. النسخة الحالية تجريبية وليست حكمًا شرعيًا على التلاوة.</p>
        {installPrompt && <div className="controls"><button className="secondary" onClick={installApp}>📲 ثبّت التطبيق على الموبايل</button></div>}
      </section>

      <div className="grid two">
        <section className="card">
          <div className="label">من عم يقرأ؟</div>
          <div className="profileRow">
            {PROFILES.map((p) => <button key={p} className={`chip ${profile === p ? "active" : ""}`} onClick={() => chooseProfile(p)}>{p}</button>)}
          </div>
        </section>

        <section className="card">
          <div className="label">اختر السورة</div>
          <select value={surahNo} onChange={(e) => chooseSurah(Number(e.target.value))}>
            {surahs.map((s) => <option value={s.number} key={s.number}>سورة {s.name}</option>)}
          </select>

          <div className="label" style={{ marginTop: 12 }}>اختر الآية</div>
          <select value={ayahNo} onChange={(e) => { stopWordAudio(); setAyahNo(Number(e.target.value)); setAnalysis(null); setAudioUrl(null); }}>
            {surah.ayahs.map((a) => <option value={a.number} key={a.number}>الآية {a.number}</option>)}
          </select>
        </section>
      </div>

      <section className="card" style={{marginTop: 14}}>
        <div className="label">سورة {surah.name} — الآية {ayah.number}</div>
        <div className="ayahText">{ayah.text}</div>
        <div className="controls">
          {!recording ? (
            <button className="primary" onClick={startRecording} disabled={busy}>🎙️ ابدأ القراءة</button>
          ) : (
            <button className="danger" onClick={stopRecording}>⏹️ انتهيت</button>
          )}
          {audioUrl && <audio controls src={audioUrl} />}
        </div>
        <div className="status info">{busy ? "عم حلّل القراءة…" : status}</div>

        {analysis && (
          <div className="result">
            <div className="score">النتيجة: {analysis.score}%</div>
            <div className="small">ما سمعه النظام: {analysis.transcript || "—"}</div>
            <div className="words">
              {wordsWithPositions.map((w) => (
                <div className="wordResult" key={`${w.expected}-${w.resultIndex}`}>
                  <span
                    className={`word ${w.status}`}
                    title={w.heard ? `سمع: ${w.heard}` : undefined}
                  >
                    {w.expected}
                  </span>
                  {(w.status === "wrong" || w.status === "missing") && w.quranPosition !== null && (
                    <button
                      type="button"
                      className="wordListen"
                      onClick={() => playWord(w.quranPosition!).catch((error) => {
                        console.error(error);
                        setStatus("ما قدرت شغّل نطق الكلمة. جرّب مرة ثانية وتأكد من اتصال الإنترنت.");
                      })}
                      disabled={playingAllMistakes}
                      aria-label={`اسمع النطق الصحيح لكلمة ${w.expected}`}
                    >
                      {playingWordPosition === w.quranPosition ? "🔊 عم يقرأ…" : "🔊 اسمع"}
                    </button>
                  )}
                </div>
              ))}
            </div>
            {wordsWithPositions.some((w) => w.status === "wrong" || w.status === "missing") && (
              <div className="controls">
                <button
                  type="button"
                  className="secondary"
                  onClick={hearAllMistakes}
                  disabled={playingAllMistakes}
                >
                  {playingAllMistakes ? "🔊 عم يقرأ الكلمات…" : "🔊 اسمع كل الكلمات التي تحتاج إعادة"}
                </button>
              </div>
            )}
            {analysis.warning && <div className="status error">{analysis.warning}</div>}
          </div>
        )}
      </section>

      <div className="notice">⚠️ التصحيح الآلي قد يخطئ، وخصوصًا في مخارج الحروف وأحكام التجويد الدقيقة. استخدمه كأداة تدريب، وليس بديلًا عن معلّم قرآن متقن.</div>
    </main>
  );
}

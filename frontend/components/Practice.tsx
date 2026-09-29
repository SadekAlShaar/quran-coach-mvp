"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fatiha } from "@/lib/fatiha";

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
  const [ayahNo, setAyahNo] = useState(1);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("اضغط على الميكروفون واقرأ الآية كاملة.");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ayah = useMemo(() => fatiha.find((a) => a.number === ayahNo)!, [ayahNo]);

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
      data.append("surah", "1");
      data.append("ayah", String(ayah.number));
      data.append("expected_text", ayah.simpleText);
      data.append("profile", profile);
      const res = await fetch(`${API}/analyze`, { method: "POST", body: data });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setAnalysis(json);
      setStatus(json.feedback);
      localStorage.setItem(`progress-${profile}-1-${ayah.number}`, JSON.stringify({ score: json.score, at: new Date().toISOString() }));
    } catch (e) {
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
          <div className="label">سورة الفاتحة — اختر الآية</div>
          <select value={ayahNo} onChange={(e) => { setAyahNo(Number(e.target.value)); setAnalysis(null); }}>
            {fatiha.map((a) => <option value={a.number} key={a.number}>الآية {a.number}</option>)}
          </select>
        </section>
      </div>

      <section className="card" style={{marginTop: 14}}>
        <div className="label">اقرأ الآية {ayah.number}</div>
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
              {analysis.words.map((w, i) => <span key={`${w.expected}-${i}`} className={`word ${w.status}`} title={w.heard ? `سمع: ${w.heard}` : undefined}>{w.expected}</span>)}
            </div>
            {analysis.warning && <div className="status error">{analysis.warning}</div>}
          </div>
        )}
      </section>

      <div className="notice">⚠️ التصحيح الآلي قد يخطئ، وخصوصًا في مخارج الحروف وأحكام التجويد الدقيقة. استخدمه كأداة تدريب، وليس بديلًا عن معلّم قرآن متقن.</div>
    </main>
  );
}

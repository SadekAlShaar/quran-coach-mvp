/// <reference lib="webworker" />

import * as ort from "onnxruntime-web/wasm";
import { createAsrSession, type SessionRunner } from "@tilawi/quran-asr";

const ASSET_BASE = "https://huggingface.co/acibZ/tilawa-quran-onnx/resolve/main";
const MODEL_URL = `${ASSET_BASE}/fastconformer_full_mixed.onnx`;
const VOCAB_URL = `${ASSET_BASE}/vocab.json`;
const QURAN_TOKENS_URL = `${ASSET_BASE}/quran_ctc_tokens.json`;
const QURAN_URL = `${ASSET_BASE}/quran.json`;
const CACHE_NAME = "quran-coach-fastconformer-v1";
const BLANK_ID = 1024;

let asrPromise: Promise<any> | null = null;

function send(type: string, payload: Record<string, unknown> = {}) {
  self.postMessage({ type, ...payload });
}

async function cachedFetch(url: string): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) return cached;

  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`Could not download Quran ASR asset (${response.status})`);
  }

  // Store a clone so subsequent recitations do not re-download the ~100 MB assets.
  await cache.put(url, response.clone());
  return response;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await cachedFetch(url);
  return response.json() as Promise<T>;
}

async function fetchModel(): Promise<ArrayBuffer> {
  send("model-progress", { progress: 5 });
  const response = await cachedFetch(MODEL_URL);
  const buffer = await response.arrayBuffer();
  send("model-progress", { progress: 72 });
  return buffer;
}

async function buildSession() {
  send("model-loading");

  // onnxruntime-web's pthread path can hang in workers/PWAs without COOP/COEP.
  // Single-thread WASM is slower but much more reliable on iPhone/Safari.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/dist/";

  const [modelBuffer, vocab, quranCtcTokens, quran] = await Promise.all([
    fetchModel(),
    fetchJson<any>(VOCAB_URL),
    fetchJson<any>(QURAN_TOKENS_URL),
    fetchJson<any>(QURAN_URL),
  ]);

  send("model-progress", { progress: 78 });

  const ortSession = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  const runner: SessionRunner = {
    async run(audio: Float32Array) {
      const audioTensor = new ort.Tensor("float32", audio, [1, audio.length]);
      const lengthTensor = new ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(audio.length)]),
        [1]
      );

      const outputs = await ortSession.run({
        audio_signal: audioTensor,
        length: lengthTensor,
      });

      const output = outputs[ortSession.outputNames[0]];
      const dims = output.dims as readonly number[];
      if (dims.length !== 3) {
        throw new Error(`Unexpected Quran model output shape: ${dims.join("x")}`);
      }

      return {
        logprobs: output.data as Float32Array,
        timeSteps: Number(dims[1]),
        vocabSize: Number(dims[2]),
      };
    },
  };

  send("model-progress", { progress: 92 });
  const session = createAsrSession(runner, {
    vocab,
    quranCtcTokens,
    quran,
    blankId: BLANK_ID,
  });

  send("model-progress", { progress: 100 });
  send("model-ready");
  return session;
}

async function getSession() {
  if (!asrPromise) {
    asrPromise = buildSession().catch((error) => {
      asrPromise = null;
      throw error;
    });
  }
  return asrPromise;
}

self.onmessage = async (event: MessageEvent) => {
  const { type } = event.data ?? {};

  try {
    if (type === "load") {
      await getSession();
      return;
    }

    if (type === "transcribe") {
      const audioBuffer = event.data?.audio as ArrayBuffer | undefined;
      if (!audioBuffer) throw new Error("Missing audio data");

      send("transcribing");
      const session = await getSession();
      const audio = new Float32Array(audioBuffer);
      const result = await session.transcribe(audio);

      send("result", {
        text: String(result?.transcript ?? "").trim(),
        matchedSurah: Number(result?.surah ?? 0),
        matchedAyah: Number(result?.ayah ?? 0),
        matchScore: Number(result?.score ?? 0),
      });
      return;
    }
  } catch (error) {
    send("error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};

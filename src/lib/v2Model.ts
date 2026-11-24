"use client";

// Version 2 : mes modèles fine-tunés (MobileNetV2) exécutés dans le navigateur avec TensorFlow.js.
// Google (Face Landmarker) trouve toujours le visage et les points ; on découpe les yeux et la bouche
// exactement comme dans l'onglet Collecte (crop.ts), puis mes modèles donnent :
//   eyeProb  = probabilité « yeux fermés » (moyenne œil droit / œil gauche)
//   yawnProb = probabilité « bâillement »

import { useEffect, useState } from "react";
import type { GraphModel } from "@tensorflow/tfjs-converter";
import type { Tensor } from "@tensorflow/tfjs-core";
import { OUT_SIZE, drawRegion, isOutside, regionFor } from "./crop";
import type { Point } from "./metrics";

type TF = typeof import("@tensorflow/tfjs-core");

export type V2Models = { tf: TF; eyes: GraphModel; mouth: GraphModel; backend: string };
export type V2Prediction = { eyeProb: number; yawnProb: number; eyeProbs: [number, number] };

export type TaskMetrics = {
  labels: string[];
  base: string;
  split: string;
  sizes: Record<"train" | "val" | "test", number>;
  test: { n: number; accuracy: number; precision: number; recall: number; f1: number; confusion: Record<"tn" | "fp" | "fn" | "tp", number> };
};
export type V2Metrics = Partial<Record<"yeux" | "bouche", TaskMetrics>>;

let shared: Promise<V2Models> | null = null;

async function loadModels(): Promise<V2Models> {
  const tf = await import("@tensorflow/tfjs-core");
  await import("@tensorflow/tfjs-backend-webgl");
  await import("@tensorflow/tfjs-backend-cpu");
  const { loadGraphModel } = await import("@tensorflow/tfjs-converter");
  try {
    await tf.setBackend("webgl");
  } catch {
    await tf.setBackend("cpu");
  }
  await tf.ready();
  const [eyes, mouth] = await Promise.all([
    loadGraphModel("/models/v2/yeux/model.json"),
    loadGraphModel("/models/v2/bouche/model.json"),
  ]);
  // Première exécution « à blanc » pour compiler les shaders (évite un saut au démarrage).
  tf.tidy(() => {
    const z = tf.zeros([2, OUT_SIZE, OUT_SIZE, 3]);
    eyes.predict(z);
    mouth.predict(tf.zeros([1, OUT_SIZE, OUT_SIZE, 3]));
  });
  return { tf, eyes, mouth, backend: tf.getBackend() };
}

export function getV2Models(): Promise<V2Models> {
  shared ??= loadModels().catch((e) => {
    shared = null;
    throw e;
  });
  return shared;
}

/** Charge mes modèles + leurs scores (public/models/v2/metrics.json). */
export function useV2Models(enabled = true) {
  const [models, setModels] = useState<V2Models | null>(null);
  const [metrics, setMetrics] = useState<V2Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getV2Models()
      .then((m) => !cancelled && setModels(m))
      .catch((e: Error) => !cancelled && setError(`Impossible de charger mon modèle : ${e.message}`));
    fetch("/models/v2/metrics.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => !cancelled && setMetrics(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { models, metrics, error };
}

// Petits canevas réutilisés pour les découpes 96×96.
const canvases: HTMLCanvasElement[] = [];
function cropCanvas(i: number) {
  if (!canvases[i]) {
    const c = document.createElement("canvas");
    c.width = OUT_SIZE;
    c.height = OUT_SIZE;
    canvases[i] = c;
  }
  return canvases[i];
}

/** Découpe les 2 yeux et la bouche, passe-les dans mes modèles. null si une zone sort de l'image. */
export function predictV2(m: V2Models, video: HTMLVideoElement, pts: Point[]): V2Prediction | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const parts = (["oeil_d", "oeil_g", "bouche"] as const).map((p) => regionFor(p, pts));
  if (parts.some((r) => isOutside(r, w, h))) return null;
  parts.forEach((r, i) => {
    const c = cropCanvas(i);
    drawRegion(c.getContext("2d", { willReadFrequently: true })!, video, r, OUT_SIZE);
  });
  const { tf } = m;
  const [e, y] = tf.tidy(() => {
    const img = (i: number) => tf.cast(tf.browser.fromPixels(cropCanvas(i)), "float32");
    const eyesBatch = tf.stack([img(0), img(1)]);
    const mouthBatch = tf.expandDims(img(2), 0);
    return [m.eyes.predict(eyesBatch) as Tensor, m.mouth.predict(mouthBatch) as Tensor];
  });
  const eyeVals = e.dataSync();
  const yawnVals = y.dataSync();
  e.dispose();
  y.dispose();
  return { eyeProb: (eyeVals[0] + eyeVals[1]) / 2, eyeProbs: [eyeVals[0], eyeVals[1]], yawnProb: yawnVals[0] };
}

/** Copie les dernières découpes dans des canevas d'aperçu (pour voir ce que le modèle voit). */
export function drawLastCrops(targets: (HTMLCanvasElement | null)[]) {
  targets.forEach((t, i) => {
    const src = canvases[i];
    if (!t || !src) return;
    const ctx = t.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, t.width, t.height);
    ctx.drawImage(src, 0, 0, t.width, t.height);
  });
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";

export type ModelStatus = "loading" | "ready" | "error";
type Loaded = { landmarker: FaceLandmarker; delegate: "GPU" | "CPU" };

// Un seul modèle pour toute l'application : chargé une fois, partagé entre les onglets
// « Détection » et « Collecte », jamais fermé (évite un double chargement en mode dev).
let shared: Promise<Loaded> | null = null;

/** MediaPipe écrit ses messages « INFO: … » avec console.error : on les range en simple info. */
function quietMediapipeInfo() {
  const w = window as Window & { __mpQuiet?: boolean };
  if (w.__mpQuiet) return;
  w.__mpQuiet = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("INFO:")) {
      console.info(...args);
      return;
    }
    original(...args);
  };
}

async function createLandmarker(): Promise<Loaded> {
  quietMediapipeInfo();
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const make = (d: "GPU" | "CPU") =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate: d },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  try {
    return { landmarker: await make("GPU"), delegate: "GPU" };
  } catch {
    return { landmarker: await make("CPU"), delegate: "CPU" };
  }
}

function getLandmarker(): Promise<Loaded> {
  shared ??= createLandmarker().catch((e) => {
    shared = null; // permet de réessayer au prochain affichage
    throw e;
  });
  return shared;
}

/** Donne accès au modèle de Google (MediaPipe Face Landmarker), fichiers servis depuis /public. */
export function useFaceLandmarker() {
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const [status, setStatus] = useState<ModelStatus>("loading");
  const [delegate, setDelegate] = useState<"GPU" | "CPU" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLandmarker()
      .then(({ landmarker, delegate: d }) => {
        if (cancelled) return;
        landmarkerRef.current = landmarker;
        setDelegate(d);
        setStatus("ready");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(`Impossible de charger le modèle : ${e.message}`);
        setStatus("error");
      });
    return () => {
      cancelled = true;
      landmarkerRef.current = null;
    };
  }, []);

  return { landmarkerRef, status, delegate, error };
}

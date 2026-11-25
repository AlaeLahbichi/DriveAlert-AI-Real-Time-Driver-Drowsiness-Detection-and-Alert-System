"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFaceLandmarker } from "@/lib/useFaceLandmarker";
import {
  DEFAULT_SETTINGS,
  DrowsinessEngine,
  LEVELS,
  type EngineEvent,
  type FaceMeasures,
  type Level,
  type Settings,
  type Snapshot,
} from "@/lib/engine";
import { AlarmPlayer } from "@/lib/alarm";
import {
  LEFT_EYE,
  MOUTH,
  RIGHT_EYE,
  eyeAspectRatio,
  headPoseFromMatrix,
  mouthAspectRatio,
  type Point,
} from "@/lib/metrics";
import LiveChart, { type ChartSample } from "./LiveChart";
import SettingsPanel from "./SettingsPanel";
import { drawLastCrops, predictV2, useV2Models, type V2Models } from "@/lib/v2Model";
import { useIot, type Iot } from "@/lib/iot";
import IotPanel from "./IotPanel";

type Status = "loading" | "ready" | "running" | "error";

const LEVEL_COLORS: Record<Level, string> = { 0: "#2A9D8F", 1: "#F2A541", 2: "#E76F51", 3: "#E5383B" };

const EVENT_ICONS: Record<EngineEvent["kind"], string> = {
  closure: "👁",
  yawn: "😮",
  nod: "↧",
  distraction: "↔",
  faceLost: "∅",
  level: "⚠",
  calibration: "◎",
};

function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-[#16243A] p-4 ${className}`}>
      {title && <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>}
      {children}
    </section>
  );
}

function Gauge({ label, value, display, max, threshold, danger }: {
  label: string;
  value: number;
  display: string;
  max: number;
  threshold?: number;
  danger: boolean;
}) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-slate-400">{label}</span>
        <span className={`font-mono text-lg ${danger ? "text-[#E76F51]" : "text-white"}`}>{display}</span>
      </div>
      <div className="relative h-2 rounded-full bg-white/10">
        <div
          className="h-2 rounded-full transition-[width] duration-100"
          style={{ width: `${pct}%`, background: danger ? "#E76F51" : "#2A9D8F" }}
        />
        {threshold !== undefined && (
          <div
            className="absolute -top-1 h-4 w-0.5 bg-[#F2A541]"
            style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }}
            title="seuil"
          />
        )}
      </div>
    </div>
  );
}

function formatClock(t0: number, t: number) {
  const s = Math.max(0, Math.round(t - t0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export type Variant = "v1" | "v2";

/** Réglages de départ : la V2 décide yeux / bouche avec mon modèle, la V1 avec les mesures de Google. */
export function defaultSettingsFor(variant: Variant): Settings {
  return variant === "v2" ? { ...DEFAULT_SETTINGS, eyeSource: "model", mouthSource: "model" } : { ...DEFAULT_SETTINGS };
}

function makeEngine(variant: Variant) {
  const e = new DrowsinessEngine();
  e.settings = defaultSettingsFor(variant);
  return e;
}

const pct = (v: number) => `${(v * 100).toFixed(1)} %`;

export default function DrowsinessApp({ variant = "v1" }: { variant?: Variant }) {
  const isV2 = variant === "v2";
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const { landmarkerRef, status: modelStatus, delegate, error: modelError } = useFaceLandmarker();
  const [initialEngine] = useState(() => makeEngine(variant));
  const engineRef = useRef(initialEngine);
  const { models: v2Models, metrics: v2Metrics, error: v2Error } = useV2Models(isV2);
  const v2Ref = useRef<V2Models | null>(null);
  const cropRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null]);
  useEffect(() => {
    v2Ref.current = v2Models;
  }, [v2Models]);
  const alarmRef = useRef(new AlarmPlayer());
  // Boîtier IoT : le niveau est publié en MQTT à chaque changement.
  const iot = useIot(variant);
  const iotRef = useRef<Iot | null>(null);
  const sentLevelRef = useRef<Level>(0);
  useEffect(() => {
    iotRef.current = iot;
  }, [iot]);
  const chartRef = useRef<ChartSample[]>([]);
  const rafRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);

  const [running, setRunning] = useState(false);
  const [cameraError, setError] = useState<string | null>(null);
  const v2Loading = isV2 && !v2Models && !v2Error;
  const status: Status = running
    ? "running"
    : modelStatus === "ready" && v2Loading
      ? "loading"
      : isV2 && v2Error
        ? "error"
        : modelStatus;
  const error = cameraError ?? modelError ?? (isV2 ? v2Error : null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [settings, setSettings] = useState<Settings>(() => defaultSettingsFor(variant));
  const [muted, setMuted] = useState(false);
  const [fps, setFps] = useState(0);
  const [sessionStart, setSessionStart] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showMesh, setShowMesh] = useState(true);
  const showMeshRef = useRef(true);

  // Nettoyage quand on quitte la page (caméra, boucle, son).
  useEffect(() => {
    const alarm = alarmRef.current;
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      alarm.dispose();
    };
  }, []);

  // ---- Dessin des points sur la vidéo ---------------------------------------
  const drawOverlay = useCallback((pts: Point[] | null, closed: boolean, yawning: boolean) => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!pts) return;

    if (showMeshRef.current) {
      ctx.fillStyle = "rgba(238,242,246,0.35)";
      for (const p of pts) ctx.fillRect(p.x - 0.75, p.y - 0.75, 1.5, 1.5);
    }

    const poly = (idx: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      idx.forEach((i, k) => (k ? ctx.lineTo(pts[i].x, pts[i].y) : ctx.moveTo(pts[i].x, pts[i].y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = color;
      for (const i of idx) {
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    // Ordre de contour : p1, p2, p3, p4, p5, p6
    const eyeColor = closed ? "#E76F51" : "#2A9D8F";
    poly(LEFT_EYE, eyeColor);
    poly(RIGHT_EYE, eyeColor);
    const m = MOUTH;
    poly([m.left, m.pairs[0][0], m.pairs[1][0], m.pairs[2][0], m.right, m.pairs[2][1], m.pairs[1][1], m.pairs[0][1]], yawning ? "#F2A541" : "#7B5EA7");
  }, []);

  // ---- Boucle de détection -------------------------------------------------
  const loop = useCallback(() => {
    let lastVideoTime = -1;
    let lastUi = 0;
    let frames = 0;
    let fpsSince = performance.now();

    const step = () => {
      rafRef.current = requestAnimationFrame(step);
      const video = videoRef.current;
      const lm = landmarkerRef.current;
      if (!video || !lm || video.readyState < 2 || video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;

      const now = performance.now();
      const res = lm.detectForVideo(video, now);
      const w = video.videoWidth;
      const h = video.videoHeight;

      let face: FaceMeasures | null = null;
      let pts: Point[] | null = null;
      if (res.faceLandmarks.length > 0) {
        pts = res.faceLandmarks[0].map((p) => ({ x: p.x * w, y: p.y * h }));
        const cats = res.faceBlendshapes?.[0]?.categories ?? [];
        const score = (name: string) => cats.find((c) => c.categoryName === name)?.score ?? 0;
        const matrix = res.facialTransformationMatrixes?.[0];
        face = {
          ear: (eyeAspectRatio(pts, LEFT_EYE) + eyeAspectRatio(pts, RIGHT_EYE)) / 2,
          mar: mouthAspectRatio(pts),
          blinkScore: (score("eyeBlinkLeft") + score("eyeBlinkRight")) / 2,
          jawOpen: score("jawOpen"),
          pose: matrix ? headPoseFromMatrix(matrix.data) : null,
        };
        // V2 : mon modèle regarde les découpes des yeux et de la bouche.
        const v2 = v2Ref.current;
        if (v2) {
          const pred = predictV2(v2, video, pts);
          if (pred) {
            face.eyeProb = pred.eyeProb;
            face.yawnProb = pred.yawnProb;
          }
        }
      }

      const engine = engineRef.current;
      const { snapshot: snap, events: evs } = engine.update(now / 1000, face);
      alarmRef.current.setLevel(snap.level);
      if (snap.level !== sentLevelRef.current) {
        sentLevelRef.current = snap.level;
        iotRef.current?.publishLevel(snap.level, snap.reasons.join(" · "));
      }
      drawOverlay(pts, snap.eyesClosed, snap.yawning);

      const buf = chartRef.current;
      buf.push({
        t: now / 1000,
        ear: snap.ear,
        earThr: snap.earThreshold,
        mar: snap.mar,
        marThr: engine.settings.marThreshold,
        eyeProb: snap.eyeProb,
        eyeThr: engine.settings.modelEyeThreshold,
        yawnProb: snap.yawnProb,
        yawnThr: engine.settings.modelYawnThreshold,
        closed: snap.eyesClosed,
      });
      while (buf.length && now / 1000 - buf[0].t > 20) buf.shift();

      frames++;
      if (now - fpsSince >= 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsSince)));
        frames = 0;
        fpsSince = now;
      }
      if (evs.length) setEvents((prev) => [...evs.reverse(), ...prev].slice(0, 80));
      if (now - lastUi > 100 || evs.length) {
        lastUi = now;
        setSnapshot(snap);
        if (v2Ref.current && pts) drawLastCrops(cropRefs.current);
      }
    };
    step();
  }, [drawOverlay, landmarkerRef]);

  // ---- Actions --------------------------------------------------------------
  const start = async () => {
    alarmRef.current.unlock();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      engineRef.current.reset();
      chartRef.current = [];
      setSessionStart(performance.now() / 1000);
      setEvents([]);
      setRunning(true);
      loop();
      // Calibration automatique au démarrage
      engineRef.current.startCalibration(performance.now() / 1000);
    } catch (e) {
      setError(`Caméra inaccessible : ${(e as Error).message}`);
    }
  };

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    alarmRef.current.setLevel(0);
    if (sentLevelRef.current !== 0) {
      sentLevelRef.current = 0;
      iotRef.current?.publishLevel(0, "Détection arrêtée");
    }
    drawOverlay(null, false, false);
    setSnapshot(null);
    setRunning(false);
  };

  const calibrate = () => engineRef.current.startCalibration(performance.now() / 1000);

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    alarmRef.current.setMuted(m);
  };

  const updateSettings = (s: Settings) => {
    setSettings(s);
    engineRef.current.settings = s;
  };

  const level: Level = snapshot?.level ?? 0;
  const color = LEVEL_COLORS[level];
  const baseline = snapshot?.baseline ?? null;

  return (
    <div className="relative min-h-screen bg-[#0F1B2D] text-[#EEF2F6]">
      {/* Cadre clignotant plein écran pour les niveaux 2 et 3 */}
      {running && level >= 2 && (
        <div
          className={`pointer-events-none fixed inset-0 z-40 border-[10px] ${level === 3 ? "alert-flash" : "alert-pulse"}`}
          style={{ borderColor: color }}
        />
      )}
      {running && level === 3 && (
        <div className="pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center">
          <div className="alert-flash rounded-2xl bg-[#E5383B] px-8 py-4 text-center shadow-2xl">
            <p className="text-3xl font-black tracking-wide">RÉVEILLEZ-VOUS !</p>
            <p className="text-sm">Arrêtez-vous dès que possible et faites une pause.</p>
          </div>
        </div>
      )}

      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">Détection de somnolence du conducteur</h1>
          <p className="text-xs text-slate-400">
            {isV2
              ? "Version 2 · mon modèle fine-tuné (MobileNetV2) pour les yeux et la bouche · Google pour le visage et la tête"
              : "Version 1 · modèle de Google (MediaPipe Face Landmarker) · alertes dans l’interface"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300">
            {status === "loading" && "Chargement du modèle…"}
            {status === "error" && "Erreur"}
            {(status === "ready" || running) &&
              (isV2 ? `Google (${delegate}) + mon modèle (${v2Models?.backend ?? "…"})` : `Modèle prêt (${delegate})`)}
            {running && ` · ${fps} FPS`}
          </span>
          {!running ? (
            <button
              onClick={start}
              disabled={status !== "ready"}
              className="rounded-lg bg-[#2A9D8F] px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              ▶ Démarrer la caméra
            </button>
          ) : (
            <>
              <button
                onClick={calibrate}
                disabled={snapshot?.calibrating}
                className="rounded-lg border border-[#F2A541] px-4 py-2 text-sm font-semibold text-[#F2A541] hover:bg-[#F2A541]/10 disabled:opacity-40"
              >
                ◎ Calibrer
              </button>
              <button
                onClick={stop}
                className="rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
              >
                ■ Arrêter
              </button>
            </>
          )}
          <button
            onClick={toggleMute}
            className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10"
            title="Activer / couper le son"
          >
            {muted ? "🔇 Son coupé" : "🔊 Son actif"}
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 rounded-lg border border-[#E76F51] bg-[#E76F51]/10 px-4 py-2 text-sm">{error}</div>
      )}

      <main className="grid gap-4 p-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* ---- Colonne gauche : vidéo + courbes ---- */}
        <div className="flex flex-col gap-4">
          <Card className="p-0 overflow-hidden">
            <div className="relative aspect-[4/3] w-full bg-black">
              <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
              <canvas ref={overlayRef} className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />

              {!running && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-slate-300">
                  <p className="text-lg font-semibold text-white">Caméra arrêtée</p>
                  <ol className="max-w-md list-decimal space-y-1 text-left text-sm">
                    <li>Cliquez sur « Démarrer la caméra » et autorisez l’accès.</li>
                    <li>Pendant 5 s, regardez l’écran, yeux ouverts, bouche fermée : c’est la calibration.</li>
                    <li>Testez : clignez, fermez les yeux 1 s puis 2 s, bâillez, baissez la tête.</li>
                  </ol>
                </div>
              )}

              {running && snapshot?.calibrating && (
                <div className="absolute inset-x-0 bottom-0 bg-black/70 p-4">
                  <p className="mb-2 text-sm">Calibration : regardez droit devant, yeux ouverts, bouche fermée…</p>
                  <div className="h-2 rounded-full bg-white/10">
                    <div
                      className="h-2 rounded-full bg-[#F2A541]"
                      style={{ width: `${(snapshot.calibrationProgress * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
              )}

              {running && snapshot && !snapshot.calibrating && (
                <div
                  className="absolute left-3 top-3 rounded-lg px-3 py-1.5 text-sm font-semibold shadow-lg"
                  style={{ background: color }}
                >
                  Niveau {level} · {LEVELS[level].name}
                </div>
              )}
              {running && snapshot && !snapshot.faceVisible && !snapshot.calibrating && (
                <div className="absolute bottom-3 left-3 rounded-lg bg-black/70 px-3 py-1.5 text-sm">
                  Aucun visage détecté depuis {snapshot.faceLostFor.toFixed(1)} s
                </div>
              )}
            </div>
            <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-400">
              <span>
                <span className="text-[#2A9D8F]">●</span> yeux ouverts&nbsp;&nbsp;
                <span className="text-[#E76F51]">●</span> yeux fermés&nbsp;&nbsp;
                <span className="text-[#7B5EA7]">●</span> bouche&nbsp;&nbsp;
                <span className="text-[#F2A541]">●</span> bâillement
              </span>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showMesh}
                  onChange={(e) => {
                    setShowMesh(e.target.checked);
                    showMeshRef.current = e.target.checked;
                  }}
                  className="accent-[#2A9D8F]"
                />
                afficher les 478 points
              </label>
            </div>
          </Card>

          <Card title="Courbes en temps réel (15 dernières secondes)">
            {isV2 ? (
              <div className="grid gap-4 md:grid-cols-2">
                <LiveChart buffer={chartRef} value="eyeProb" max={1} color="#E76F51" label="Mon modèle : probabilité yeux fermés" />
                <LiveChart buffer={chartRef} value="yawnProb" max={1} color="#F2A541" label="Mon modèle : probabilité bâillement" />
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <LiveChart buffer={chartRef} value="ear" max={0.45} color="#2A9D8F" label="EAR (ouverture des yeux) · zones rouges = yeux fermés" />
                <LiveChart buffer={chartRef} value="mar" max={1} color="#7B5EA7" label="MAR (ouverture de la bouche)" />
              </div>
            )}
          </Card>

          {isV2 && (
            <Card title="Ce que voit mon modèle (découpes 96×96)">
              <div className="flex flex-wrap items-end gap-4">
                {(["Œil droit", "Œil gauche", "Bouche"] as const).map((label, i) => (
                  <div key={label} className="flex flex-col items-center gap-1">
                    <canvas
                      ref={(el) => {
                        cropRefs.current[i] = el;
                      }}
                      width={96}
                      height={96}
                      className="h-24 w-24 rounded-lg border border-white/10 bg-black"
                    />
                    <span className="text-xs text-slate-400">{label}</span>
                  </div>
                ))}
                {v2Metrics && (
                  <div className="min-w-56 flex-1 text-xs text-slate-300">
                    <p className="mb-1 font-semibold text-slate-200">Scores sur les images de test</p>
                    {(["yeux", "bouche"] as const).map((k) => {
                      const m = v2Metrics[k];
                      if (!m) return null;
                      return (
                        <p key={k}>
                          {k === "yeux" ? "Yeux" : "Bouche"} : exactitude {pct(m.test.accuracy)} · F1 {pct(m.test.f1)} ·{" "}
                          {m.test.n} images
                        </p>
                      );
                    })}
                    <p className="mt-1 text-slate-500">{v2Metrics.yeux?.base} · découpage {v2Metrics.yeux?.split}</p>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        {/* ---- Colonne droite : niveau, mesures, historique ---- */}
        <div className="flex flex-col gap-4">
          <Card title="Niveau d’alerte">
            <div className="flex items-center gap-4">
              <div
                className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-full text-4xl font-black ${
                  running && level === 3 ? "alert-flash" : ""
                }`}
                style={{ background: running ? color : "#334155" }}
              >
                {running ? level : "–"}
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-bold" style={{ color: running ? color : undefined }}>
                  {running ? LEVELS[level].name : "En attente"}
                </p>
                <p className="text-sm text-slate-400">{running ? LEVELS[level].hint : "Démarrez la caméra"}</p>
                {running && snapshot && snapshot.reasons.length > 0 && (
                  <p className="mt-1 truncate text-xs text-slate-300">Cause : {snapshot.reasons.join(" · ")}</p>
                )}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-4 gap-1">
              {([0, 1, 2, 3] as Level[]).map((l) => (
                <div
                  key={l}
                  className="rounded-md py-1 text-center text-[11px] font-semibold transition"
                  style={{
                    background: running && l === level ? LEVEL_COLORS[l] : "rgba(255,255,255,0.05)",
                    color: running && l === level ? "white" : LEVEL_COLORS[l],
                  }}
                >
                  {l} · {LEVELS[l].name}
                </div>
              ))}
            </div>
          </Card>

          <Card title="Mesures">
            <div className="flex flex-col gap-3">
              {isV2 && (
                <>
                  <Gauge
                    label="Mon modèle · probabilité yeux fermés"
                    value={snapshot?.eyeProb ?? 0}
                    display={snapshot ? snapshot.eyeProb.toFixed(2) : "–"}
                    max={1}
                    threshold={settings.modelEyeThreshold}
                    danger={!!snapshot?.eyesClosed}
                  />
                  <Gauge
                    label="Mon modèle · probabilité bâillement"
                    value={snapshot?.yawnProb ?? 0}
                    display={snapshot ? snapshot.yawnProb.toFixed(2) : "–"}
                    max={1}
                    threshold={settings.modelYawnThreshold}
                    danger={(snapshot?.yawnProb ?? 0) > settings.modelYawnThreshold}
                  />
                </>
              )}
              <Gauge
                label={`EAR · seuil ${snapshot ? snapshot.earThreshold.toFixed(3) : "–"}${baseline ? " (calibré)" : " (par défaut)"}`}
                value={snapshot?.ear ?? 0}
                display={snapshot ? snapshot.ear.toFixed(3) : "–"}
                max={0.45}
                threshold={snapshot?.earThreshold}
                danger={!!snapshot?.eyesClosed}
              />
              <Gauge
                label="Score eyeBlink (Google)"
                value={snapshot?.blinkScore ?? 0}
                display={snapshot ? snapshot.blinkScore.toFixed(2) : "–"}
                max={1}
                threshold={settings.blinkScoreThreshold}
                danger={(snapshot?.blinkScore ?? 0) > settings.blinkScoreThreshold}
              />
              <Gauge
                label="MAR (bouche)"
                value={snapshot?.mar ?? 0}
                display={snapshot ? snapshot.mar.toFixed(2) : "–"}
                max={1}
                threshold={settings.marThreshold}
                danger={!!snapshot?.yawning}
              />
              <Gauge
                label="PERCLOS (yeux fermés sur 60 s)"
                value={snapshot?.perclos ?? 0}
                display={snapshot ? `${(snapshot.perclos * 100).toFixed(0)} %` : "–"}
                max={0.6}
                threshold={settings.perclosWarn}
                danger={(snapshot?.perclos ?? 0) >= settings.perclosWarn}
              />
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[
                ["Fermeture", snapshot ? `${snapshot.closedFor.toFixed(1)} s` : "–", (snapshot?.closedFor ?? 0) >= settings.closedAlertS],
                ["Clignements", snapshot ? `${Math.round(snapshot.blinksPerMin)}/min` : "–", false],
                ["Bâillements", snapshot ? `${snapshot.yawnsRecent} /5 min` : "–", (snapshot?.yawnsRecent ?? 0) >= 2],
                ["Tête ↕ (pitch)", snapshot ? `${snapshot.pitchDelta.toFixed(0)}°` : "–", Math.abs(snapshot?.pitchDelta ?? 0) > settings.pitchDeg],
                ["Tête ↔ (yaw)", snapshot ? `${snapshot.yawDelta.toFixed(0)}°` : "–", Math.abs(snapshot?.yawDelta ?? 0) > settings.yawDeg],
                ["Hochements", snapshot ? `${snapshot.nodsRecent} /min` : "–", (snapshot?.nodsRecent ?? 0) >= 2],
              ].map(([label, val, bad]) => (
                <div key={label as string} className="rounded-lg bg-white/5 px-2 py-2">
                  <p className="text-[11px] text-slate-400">{label}</p>
                  <p className={`font-mono text-base ${bad ? "text-[#E76F51]" : "text-white"}`}>{val}</p>
                </div>
              ))}
            </div>
          </Card>

          <IotPanel iot={iot} />

          <Card title="Historique des événements" className="flex min-h-0 flex-col">
            {events.length === 0 ? (
              <p className="text-sm text-slate-500">Aucun événement pour le moment.</p>
            ) : (
              <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-2 rounded-md bg-white/5 px-2 py-1.5">
                    <span className="w-12 shrink-0 font-mono text-xs leading-5 text-slate-400">
                      {formatClock(sessionStart, e.t)}
                    </span>
                    <span className="w-4 shrink-0 text-center">{EVENT_ICONS[e.kind]}</span>
                    <span style={{ color: e.level !== undefined ? LEVEL_COLORS[e.level] : undefined }}>{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ---- Réglages ---- */}
        <Card className="xl:col-span-2">
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-wider text-slate-400"
          >
            <span>Réglages des seuils</span>
            <span>{showSettings ? "▲" : "▼"}</span>
          </button>
          {showSettings && (
            <div className="mt-4">
              <SettingsPanel
                settings={settings}
                onChange={updateSettings}
                onReset={() => updateSettings(defaultSettingsFor(variant))}
                withModel={isV2}
              />
            </div>
          )}
        </Card>
      </main>

      <footer className="px-6 pb-6 text-xs text-slate-500">
        Tout est calculé dans le navigateur : aucune image n’est envoyée sur Internet. Seuls le niveau d’alerte, sa cause
        et (si vous la partagez) votre position sont envoyés au boîtier ESP32 par MQTT.
      </footer>
    </div>
  );
}


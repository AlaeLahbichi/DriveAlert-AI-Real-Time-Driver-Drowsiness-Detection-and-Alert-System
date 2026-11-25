"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
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
import { C, LEVEL_COLORS } from "@/lib/theme";
import { saveSession, type SessionLog } from "@/lib/logStore";
import { openCamera } from "@/lib/camera";

type Status = "loading" | "ready" | "running" | "error";
type SideTab = "mesures" | "iot" | "events" | "reglages";

const EVENT_ICONS: Record<EngineEvent["kind"], string> = {
  closure: "👁",
  yawn: "😮",
  nod: "↧",
  distraction: "↔",
  faceLost: "∅",
  level: "⚠",
  calibration: "◎",
};

// Libellés des pastilles d'état des courbes (constantes : pas de re-création à chaque rendu).
const EYE_STATES = ["Ouverts", "Fermés"] as const;
const MOUTH_STATES = ["Fermée", "Bâillement"] as const;

function Card({ title, right, children, className = "" }: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>}
          {right}
        </div>
      )}
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
        <span className="text-xs text-muted">{label}</span>
        <span className={`font-mono text-base tabular-nums ${danger ? "text-danger" : "text-ink"}`}>{display}</span>
      </div>
      <div className="relative h-2 rounded-full bg-raised">
        <div
          className="h-2 rounded-full transition-[width] duration-100"
          style={{ width: `${pct}%`, background: danger ? C.danger : C.brand }}
        />
        {threshold !== undefined && (
          <div
            className="absolute -top-1 h-4 w-0.5 rounded bg-soft"
            style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }}
            title="seuil"
          />
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, bad }: { label: string; value: string; bad: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${bad ? "border-danger/60 bg-danger/10" : "border-line bg-raised"}`}>
      <p className="text-[11px] text-muted">{label}</p>
      <p className={`font-mono text-lg font-semibold tabular-nums ${bad ? "text-danger" : "text-ink"}`}>
        {bad && <span aria-label="au-delà du seuil">▲ </span>}
        {value}
      </p>
    </div>
  );
}

function formatClock(t0: number, t: number) {
  const s = Math.max(0, Math.round(t - t0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Historique : mémorisé pour ne pas se redessiner à chaque image. */
const EventsList = memo(function EventsList({ events, sessionStart }: { events: EngineEvent[]; sessionStart: number }) {
  if (events.length === 0) return <p className="text-sm text-faint">Aucun événement pour le moment.</p>;
  return (
    <ul className="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1 text-sm">
      {events.map((e) => (
        <li key={e.id} className="flex gap-2 rounded-lg bg-raised px-2 py-1.5">
          <span className="w-12 shrink-0 font-mono text-xs leading-5 text-muted">{formatClock(sessionStart, e.t)}</span>
          <span className="w-4 shrink-0 text-center">{EVENT_ICONS[e.kind]}</span>
          <span className="flex-1">
            {e.level !== undefined && (
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: LEVEL_COLORS[e.level] }} />
            )}
            {e.message}
          </span>
        </li>
      ))}
    </ul>
  );
});

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
  // Session en cours, enregistrée pour le tableau de bord.
  const sessionRef = useRef<SessionLog | null>(null);
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
  const [tab, setTab] = useState<SideTab>("mesures");
  const [curves, setCurves] = useState<"model" | "geometry">(isV2 ? "model" : "geometry");
  const [showMesh, setShowMesh] = useState(true);
  const showMeshRef = useRef(true);

  const endSession = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.end = Date.now();
    saveSession(s);
    sessionRef.current = null;
  }, []);

  // Nettoyage quand on quitte la page (caméra, boucle, son, session).
  useEffect(() => {
    const alarm = alarmRef.current;
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      alarm.dispose();
      endSession();
    };
  }, [endSession]);

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
      ctx.fillStyle = "rgba(238,241,247,0.35)";
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
    const eyeColor = closed ? C.danger : C.eye;
    poly(LEFT_EYE, eyeColor);
    poly(RIGHT_EYE, eyeColor);
    const m = MOUTH;
    poly([m.left, m.pairs[0][0], m.pairs[1][0], m.pairs[2][0], m.right, m.pairs[2][1], m.pairs[1][1], m.pairs[0][1]], yawning ? C.danger : C.mouth);
  }, []);

  // ---- Boucle de détection -------------------------------------------------
  const loop = useCallback(() => {
    let lastVideoTime = -1;
    let lastUi = 0;
    let lastSave = 0;
    let lastWall = Date.now();
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
      // Réaction immédiate : son et boîtier d'abord, affichage ensuite.
      alarmRef.current.setLevel(snap.level);
      const levelChanged = snap.level !== sentLevelRef.current;
      if (levelChanged) {
        sentLevelRef.current = snap.level;
        iotRef.current?.publishLevel(snap.level, snap.reasons.join(" · "));
      }
      drawOverlay(pts, snap.eyesClosed, snap.yawning);

      // Journal de la session (tableau de bord)
      const wall = Date.now();
      const sess = sessionRef.current;
      if (sess) {
        sess.levelMs[snap.level] += Math.min(1000, wall - lastWall);
        if (levelChanged) sess.timeline.push({ at: wall, level: snap.level });
        for (const e of evs) sess.events.push({ at: wall, kind: e.kind, level: e.level, message: e.message });
        sess.end = wall;
        if (wall - lastSave > 3000) {
          lastSave = wall;
          saveSession(sess);
        }
      }
      lastWall = wall;

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
        yawning: snap.yawning,
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
      const stream = await openCamera({ width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      engineRef.current.reset();
      chartRef.current = [];
      const t0 = Date.now();
      sessionRef.current = {
        id: `${variant}-${t0}`,
        variant,
        start: t0,
        end: t0,
        levelMs: [0, 0, 0, 0],
        timeline: [{ at: t0, level: 0 }],
        events: [],
      };
      setSessionStart(performance.now() / 1000);
      setEvents([]);
      setError(null);
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
    endSession();
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

  const updateSettings = useCallback((s: Settings) => {
    setSettings(s);
    engineRef.current.settings = s;
  }, []);
  const resetSettings = useCallback(() => updateSettings(defaultSettingsFor(variant)), [updateSettings, variant]);

  const level: Level = snapshot?.level ?? 0;
  const color = LEVEL_COLORS[level];
  const baseline = snapshot?.baseline ?? null;
  const showModelCurves = isV2 && curves === "model";

  const TABS: { id: SideTab; label: string }[] = [
    { id: "mesures", label: "Mesures" },
    { id: "iot", label: "Boîtier IoT" },
    { id: "events", label: `Événements${events.length ? ` (${events.length})` : ""}` },
    { id: "reglages", label: "Réglages" },
  ];

  return (
    <div className="relative min-h-screen bg-base text-ink">
      {/* Cadre clignotant plein écran pour les niveaux 2 et 3 */}
      {running && level >= 2 && (
        <div
          className={`pointer-events-none fixed inset-0 z-40 border-[10px] ${level === 3 ? "alert-flash" : "alert-pulse"}`}
          style={{ borderColor: color }}
        />
      )}
      {running && level === 3 && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center">
          <div className="alert-flash rounded-2xl bg-danger px-8 py-4 text-center text-white shadow-2xl">
            <p className="text-3xl font-black tracking-wide">RÉVEILLEZ-VOUS !</p>
            <p className="text-sm">Arrêtez-vous dès que possible et faites une pause.</p>
          </div>
        </div>
      )}

      {/* ---- En-tête de page : titre, état, actions ---- */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">
            {isV2 ? "Détection · V2 mon modèle" : "Détection · V1 modèle de Google"}
          </h1>
          <p className="text-xs text-muted">
            {isV2
              ? "MobileNetV2 fine-tuné pour les yeux et la bouche · Google pour le visage et la tête"
              : "MediaPipe Face Landmarker (478 points) · décision par EAR, MAR et pose de la tête"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-soft">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: status === "error" ? C.danger : status === "loading" ? C.warn : C.ok }}
            />
            {status === "loading" && "Chargement du modèle…"}
            {status === "error" && "Erreur"}
            {(status === "ready" || running) &&
              (isV2 ? `Google (${delegate}) + mon modèle (${v2Models?.backend ?? "…"})` : `Modèle prêt (${delegate})`)}
            {running && <span className="font-mono text-ink">· {fps} FPS</span>}
          </span>
          <span className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-soft">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: iot.box?.enLigne ? C.ok : iot.box ? C.danger : C.faint }}
            />
            Boîtier {iot.box?.enLigne ? "en ligne" : iot.box ? "hors ligne" : "jamais vu"}
          </span>
          {!running ? (
            <button
              onClick={start}
              disabled={status !== "ready"}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-hi disabled:opacity-40"
            >
              ▶ Démarrer la caméra
            </button>
          ) : (
            <>
              <button
                onClick={calibrate}
                disabled={snapshot?.calibrating}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold hover:bg-raised disabled:opacity-40"
              >
                ◎ Calibrer
              </button>
              <button
                onClick={stop}
                className="rounded-lg border border-danger/60 px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/10"
              >
                ■ Arrêter
              </button>
            </>
          )}
          <button
            onClick={toggleMute}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm hover:bg-raised"
            title="Activer / couper le son"
          >
            {muted ? "🔇 Son coupé" : "🔊 Son actif"}
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 rounded-lg border border-danger bg-danger/10 px-4 py-2 text-sm">{error}</div>
      )}

      <main className="grid gap-4 p-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        {/* ---- Colonne gauche : caméra puis courbes ---- */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden p-0">
            <div className="relative aspect-[16/10] w-full bg-black">
              <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
              <canvas ref={overlayRef} className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />

              {!running && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center text-soft">
                  <p className="text-lg font-semibold text-ink">Caméra arrêtée</p>
                  <ol className="max-w-md space-y-2 text-left text-sm">
                    {[
                      "Cliquez sur « Démarrer la caméra » et autorisez l’accès.",
                      "Pendant 5 s, regardez l’écran, yeux ouverts, bouche fermée : c’est la calibration.",
                      "Testez : clignez, fermez les yeux 1 s puis 2 s, bâillez, baissez la tête.",
                    ].map((s, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
                          {i + 1}
                        </span>
                        {s}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {running && snapshot?.calibrating && (
                <div className="absolute inset-x-0 bottom-0 bg-black/70 p-4">
                  <p className="mb-2 text-sm">Calibration : regardez droit devant, yeux ouverts, bouche fermée…</p>
                  <div className="h-2 rounded-full bg-white/10">
                    <div
                      className="h-2 rounded-full bg-brand-hi"
                      style={{ width: `${(snapshot.calibrationProgress * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
              )}

              {running && snapshot && !snapshot.calibrating && (
                <div
                  className="absolute left-3 top-3 rounded-lg px-3 py-1.5 text-sm font-bold text-black shadow-lg"
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
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-muted">
              <span className="flex flex-wrap gap-x-3">
                <span><span style={{ color: C.eye }}>●</span> yeux</span>
                <span><span style={{ color: C.mouth }}>●</span> bouche</span>
                <span><span style={{ color: C.danger }}>●</span> fermés / bâillement</span>
              </span>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showMesh}
                  onChange={(e) => {
                    setShowMesh(e.target.checked);
                    showMeshRef.current = e.target.checked;
                  }}
                  className="accent-brand"
                />
                afficher les 478 points
              </label>
            </div>
          </Card>

          <Card
            title="Courbes en temps réel · 15 dernières secondes"
            right={
              isV2 && (
                <div className="flex rounded-lg border border-line bg-raised p-0.5 text-xs">
                  {(
                    [
                      ["model", "Mon modèle"],
                      ["geometry", "Géométrie (EAR / MAR)"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setCurves(id)}
                      className={`rounded-md px-2.5 py-1 ${curves === id ? "bg-brand text-white" : "text-soft hover:text-ink"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )
            }
          >
            <div className="grid gap-3 lg:grid-cols-2">
              {showModelCurves ? (
                <>
                  <LiveChart
                    key="eyeProb"
                    buffer={chartRef}
                    value="eyeProb"
                    max={1}
                    color={C.eye}
                    title="Yeux · probabilité « fermés »"
                    hint="Sortie de mon modèle : plus c’est haut, plus les yeux sont fermés."
                    alarm="above"
                    states={EYE_STATES}
                  />
                  <LiveChart
                    key="yawnProb"
                    buffer={chartRef}
                    value="yawnProb"
                    max={1}
                    color={C.mouth}
                    title="Bouche · probabilité « bâillement »"
                    hint="Sortie de mon modèle : plus c’est haut, plus la bouche bâille."
                    alarm="above"
                    states={MOUTH_STATES}
                  />
                </>
              ) : (
                <>
                  <LiveChart
                    key="ear"
                    buffer={chartRef}
                    value="ear"
                    max={0.4}
                    color={C.eye}
                    title="Yeux · EAR (ouverture)"
                    hint="Sous le seuil = yeux fermés. Un clignement fait une pointe courte vers le bas."
                    alarm="below"
                    states={EYE_STATES}
                    digits={3}
                  />
                  <LiveChart
                    key="mar"
                    buffer={chartRef}
                    value="mar"
                    max={1}
                    color={C.mouth}
                    title="Bouche · MAR (ouverture)"
                    hint="Au-dessus du seuil assez longtemps = bâillement."
                    alarm="above"
                    states={MOUTH_STATES}
                  />
                </>
              )}
            </div>
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
                      className="h-24 w-24 rounded-lg border border-line bg-black"
                    />
                    <span className="text-xs text-muted">{label}</span>
                  </div>
                ))}
                {v2Metrics && (
                  <div className="min-w-56 flex-1 text-xs text-soft">
                    <p className="mb-1 font-semibold text-ink">Scores sur les images de test</p>
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
                    <p className="mt-1 text-faint">{v2Metrics.yeux?.base} · découpage {v2Metrics.yeux?.split}</p>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        {/* ---- Colonne droite : niveau, indicateurs, panneau à onglets ---- */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Niveau d’alerte">
            <div className="flex items-center gap-4">
              <div
                className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-full text-4xl font-black ${
                  running && level === 3 ? "alert-flash" : ""
                }`}
                style={{ background: running ? color : C.raised, color: running ? "#000" : C.faint }}
              >
                {running ? level : "–"}
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-bold" style={{ color: running ? color : undefined }}>
                  {running ? LEVELS[level].name : "En attente"}
                </p>
                <p className="text-sm text-muted">{running ? LEVELS[level].hint : "Démarrez la caméra"}</p>
                {running && snapshot && snapshot.reasons.length > 0 && (
                  <p className="mt-1 truncate text-xs text-soft">Cause : {snapshot.reasons.join(" · ")}</p>
                )}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-4 gap-1">
              {([0, 1, 2, 3] as Level[]).map((l) => {
                const on = running && l === level;
                return (
                  <div
                    key={l}
                    className="rounded-md border py-1 text-center text-[11px] font-semibold transition"
                    style={{
                      background: on ? LEVEL_COLORS[l] : "transparent",
                      borderColor: on ? LEVEL_COLORS[l] : C.line,
                      color: on ? "#000" : C.soft,
                    }}
                  >
                    <span
                      className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                      style={{ background: on ? "#000" : LEVEL_COLORS[l] }}
                    />
                    {l} · {LEVELS[l].name}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Indicateurs clés">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Kpi
                label="Yeux fermés depuis"
                value={snapshot ? `${snapshot.closedFor.toFixed(1)} s` : "–"}
                bad={(snapshot?.closedFor ?? 0) >= settings.closedAlertS}
              />
              <Kpi
                label="PERCLOS (60 s)"
                value={snapshot ? `${(snapshot.perclos * 100).toFixed(0)} %` : "–"}
                bad={(snapshot?.perclos ?? 0) >= settings.perclosWarn}
              />
              <Kpi label="Clignements" value={snapshot ? `${Math.round(snapshot.blinksPerMin)}/min` : "–"} bad={false} />
              <Kpi
                label="Bâillements (5 min)"
                value={snapshot ? `${snapshot.yawnsRecent}` : "–"}
                bad={(snapshot?.yawnsRecent ?? 0) >= 2}
              />
              <Kpi
                label="Hochements (1 min)"
                value={snapshot ? `${snapshot.nodsRecent}` : "–"}
                bad={(snapshot?.nodsRecent ?? 0) >= 2}
              />
              <Kpi
                label="Tête ↕ / ↔"
                value={snapshot ? `${snapshot.pitchDelta.toFixed(0)}° / ${snapshot.yawDelta.toFixed(0)}°` : "–"}
                bad={
                  Math.abs(snapshot?.pitchDelta ?? 0) > settings.pitchDeg || Math.abs(snapshot?.yawDelta ?? 0) > settings.yawDeg
                }
              />
            </div>
          </Card>

          <section className="flex min-h-0 flex-col rounded-2xl border border-line bg-surface">
            <div role="tablist" className="flex gap-1 border-b border-line p-1.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition sm:text-sm ${
                    tab === t.id ? "bg-raised text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {tab === "mesures" && (
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
              )}
              {tab === "iot" && <IotPanel iot={iot} />}
              {tab === "events" && <EventsList events={events} sessionStart={sessionStart} />}
              {tab === "reglages" && (
                <SettingsPanel settings={settings} onChange={updateSettings} onReset={resetSettings} withModel={isV2} />
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="px-6 pb-6 text-xs text-faint">
        Tout est calculé dans le navigateur : aucune image n’est envoyée sur Internet. Seuls le niveau d’alerte, sa cause
        et (si vous la partagez) votre position sont envoyés au boîtier ESP32 par MQTT. L’historique des sessions est gardé
        dans ce navigateur pour le tableau de bord.
      </footer>
    </div>
  );
}

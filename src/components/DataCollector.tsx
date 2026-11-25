"use client";

// Onglet « Collecte de données » : filmer, découper les yeux et la bouche,
// étiqueter (au clavier ou automatiquement avec MediaPipe) et tout enregistrer dans data/.

import { useCallback, useEffect, useRef, useState } from "react";
import { useFaceLandmarker } from "@/lib/useFaceLandmarker";
import { eyeAspectRatio, headPoseFromMatrix, LEFT_EYE, mouthAspectRatio, RIGHT_EYE, type Point } from "@/lib/metrics";
import { cropToDataUrl, drawRegion, isOutside, regionFor, type Region } from "@/lib/crop";
import { openCamera } from "@/lib/camera";
import {
  CLASSES,
  CLASS_KEYS,
  TARGET_PER_CLASS,
  type CaptureItem,
  type CaptureMeta,
  type ClassKey,
  type DatasetStats,
  type Part,
  type SaveRequest,
  type SavedFile,
} from "@/lib/datasetClasses";

type Mode = "manuel" | "auto";
type Lighting = SaveRequest["lighting"];
type EyeLabel = "yeux_ouverts" | "yeux_fermes" | null;
type MouthLabel = "bouche_fermee" | "bouche_baillement" | null;
type Recent = { file: string; cls: ClassKey; url: string; burst: string };

const KEY_TO_CLASS: Record<string, ClassKey> = {
  o: "yeux_ouverts",
  f: "yeux_fermes",
  n: "bouche_fermee",
  b: "bouche_baillement",
};

const PARTS_OF: Record<"yeux" | "bouche", Part[]> = { yeux: ["oeil_d", "oeil_g"], bouche: ["bouche"] };

const AUTO_DEFAULT = { closedMin: 0.55, openMax: 0.25, yawnMin: 0.45, normalMax: 0.1 };

const emptyCounts = () => Object.fromEntries(CLASS_KEYS.map((k) => [k, 0])) as Record<ClassKey, number>;

function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 ${className}`}>
      {title && <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>}
      {children}
    </section>
  );
}

function Slider({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-soft">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-white">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-brand"
      />
    </label>
  );
}

const newBurst = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

export default function DataCollector() {
  const { landmarkerRef, status: modelStatus, delegate, error: modelError } = useFaceLandmarker();

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const previewRefs = useRef<Record<Part, HTMLCanvasElement | null>>({ oeil_d: null, oeil_g: null, bouche: null });
  const rafRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const heldRef = useRef(new Map<ClassKey, string>()); // classe maintenue → identifiant de rafale
  const inflightRef = useRef(0);
  const burstFilesRef = useRef(new Map<string, string[]>());
  const burstOrderRef = useRef<string[]>([]);
  const statsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Réglages de la séance ----
  const [person, setPerson] = useState("");
  const [session, setSession] = useState("");
  const [glasses, setGlasses] = useState(false);
  const [lighting, setLighting] = useState<Lighting>("jour");
  const [mode, setMode] = useState<Mode>("manuel");
  const [everyN, setEveryN] = useState(5);
  const [auto, setAuto] = useState(AUTO_DEFAULT);
  const [autoTasks, setAutoTasks] = useState({ yeux: true, bouche: true });
  const [rejectInconsistent, setRejectInconsistent] = useState(true);
  const [tickSound, setTickSound] = useState(true);

  // ---- État ----
  const [running, setRunning] = useState(false);
  const [recording, setRecording] = useState(false);
  const [autoBurst, setAutoBurst] = useState("");
  const [held, setHeld] = useState<ClassKey[]>([]);
  const [fps, setFps] = useState(0);
  const [suggest, setSuggest] = useState<{ face: boolean; eyes: EyeLabel; mouth: MouthLabel; blink: number; jaw: number }>({
    face: false,
    eyes: null,
    mouth: null,
    blink: 0,
    jaw: 0,
  });
  const [recent, setRecent] = useState<Recent[]>([]);
  const [sessionCounts, setSessionCounts] = useState(emptyCounts);
  const [rejected, setRejected] = useState({ incoherent: 0, horsCadre: 0, tete: 0, surcharge: 0 });
  const [stats, setStats] = useState<DatasetStats | null>(null);
  const [splitMsg, setSplitMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- Vérification (galerie) ----
  const [reviewCls, setReviewCls] = useState<ClassKey>("yeux_fermes");
  const [reviewFiles, setReviewFiles] = useState<string[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // La boucle d'image lit les réglages via une ref (pas de re-création à chaque changement).
  const cfgRef = useRef({
    person, session, glasses, lighting, mode, everyN, auto, autoTasks, rejectInconsistent, tickSound, recording, autoBurst,
  });
  useEffect(() => {
    cfgRef.current = {
      person, session, glasses, lighting, mode, everyN, auto, autoTasks, rejectInconsistent, tickSound, recording, autoBurst,
    };
  });

  // ---- Statistiques de la base ----------------------------------------------
  const refreshStats = useCallback(async () => {
    try {
      const res = await fetch("/api/dataset", { cache: "no-store" });
      setStats(await res.json());
    } catch {
      /* serveur indisponible */
    }
  }, []);

  const scheduleStats = useCallback(() => {
    if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
    statsTimerRef.current = setTimeout(refreshStats, 1200);
  }, [refreshStats]);

  const loadReview = useCallback(async (cls: ClassKey, offset = 0) => {
    const res = await fetch(`/api/dataset/list?cls=${cls}&offset=${offset}&limit=60`, { cache: "no-store" });
    const data = (await res.json()) as { total: number; files: string[] };
    setReviewTotal(data.total);
    setReviewFiles((prev) => (offset === 0 ? data.files : [...prev, ...data.files]));
    if (offset === 0) setSelected(new Set());
  }, []);

  // Premier chargement des statistiques.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/dataset", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: DatasetStats) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Enregistrement ---------------------------------------------------------
  const tick = useCallback(() => {
    const ctx = audioRef.current;
    if (!ctx || !cfgRef.current.tickSound) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1600;
    gain.gain.setValueAtTime(0.05, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  }, []);

  const send = useCallback(
    async (items: CaptureItem[], burst: string) => {
      const cfg = cfgRef.current;
      const body: SaveRequest = {
        person: cfg.person,
        session: cfg.session,
        source: cfg.mode,
        burst,
        glasses: cfg.glasses,
        lighting: cfg.lighting,
        captures: items,
      };
      inflightRef.current++;
      try {
        const res = await fetch("/api/dataset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { saved?: SavedFile[]; error?: string };
        if (!res.ok || !data.saved) throw new Error(data.error ?? "Erreur d'enregistrement");
        const saved = data.saved;
        const files = burstFilesRef.current.get(burst) ?? [];
        if (!burstFilesRef.current.has(burst)) burstOrderRef.current.push(burst);
        burstFilesRef.current.set(burst, [...files, ...saved.map((s) => s.file)]);
        setRecent((prev) => [...saved.map((s, i) => ({ ...s, url: items[i].image, burst })).reverse(), ...prev].slice(0, 48));
        setSessionCounts((prev) => {
          const next = { ...prev };
          saved.forEach((s) => next[s.cls]++);
          return next;
        });
        scheduleStats();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        inflightRef.current--;
      }
    },
    [scheduleStats],
  );

  const deleteFiles = useCallback(
    async (files: string[]) => {
      if (files.length === 0) return;
      await fetch("/api/dataset", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      const gone = new Set(files);
      setRecent((prev) => {
        const removed = prev.filter((r) => gone.has(r.file));
        if (removed.length) {
          setSessionCounts((c) => {
            const next = { ...c };
            removed.forEach((r) => (next[r.cls] = Math.max(0, next[r.cls] - 1)));
            return next;
          });
        }
        return prev.filter((r) => !gone.has(r.file));
      });
      for (const [b, fs] of burstFilesRef.current) burstFilesRef.current.set(b, fs.filter((f) => !gone.has(f)));
      setReviewFiles((prev) => prev.filter((f) => !gone.has(f)));
      setReviewTotal((t) => Math.max(0, t - files.length));
      setSelected(new Set());
      void refreshStats();
    },
    [refreshStats],
  );

  const undoLastBurst = () => {
    while (burstOrderRef.current.length) {
      const b = burstOrderRef.current.pop()!;
      const files = burstFilesRef.current.get(b) ?? [];
      burstFilesRef.current.delete(b);
      if (files.length) {
        void deleteFiles(files);
        return;
      }
    }
  };

  // ---- Dessin ------------------------------------------------------------------
  const drawOverlay = useCallback((regions: Record<Part, Region> | null, colors: Record<Part, string | null>) => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!regions) return;
    for (const part of ["oeil_d", "oeil_g", "bouche"] as Part[]) {
      const r = regions[part];
      ctx.save();
      ctx.translate(r.center.x, r.center.y);
      ctx.rotate(r.angle);
      ctx.strokeStyle = colors[part] ?? "rgba(238,242,246,0.6)";
      ctx.lineWidth = colors[part] ? 4 : 2;
      ctx.setLineDash(colors[part] ? [] : [6, 5]);
      ctx.strokeRect(-r.size / 2, -r.size / 2, r.size, r.size);
      ctx.restore();
    }
  }, []);

  // ---- Boucle -------------------------------------------------------------------
  const loop = useCallback(() => {
    let lastVideoTime = -1;
    let frame = 0;
    let frames = 0;
    let fpsSince = performance.now();
    let lastUi = 0;

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
      const cfg = cfgRef.current;

      frames++;
      if (now - fpsSince >= 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsSince)));
        frames = 0;
        fpsSince = now;
      }

      if (res.faceLandmarks.length === 0) {
        drawOverlay(null, { oeil_d: null, oeil_g: null, bouche: null });
        if (now - lastUi > 150) {
          lastUi = now;
          setSuggest({ face: false, eyes: null, mouth: null, blink: 0, jaw: 0 });
        }
        return;
      }

      const pts: Point[] = res.faceLandmarks[0].map((p) => ({ x: p.x * w, y: p.y * h }));
      const cats = res.faceBlendshapes?.[0]?.categories ?? [];
      const score = (n: string) => cats.find((c) => c.categoryName === n)?.score ?? 0;
      const blink = (score("eyeBlinkLeft") + score("eyeBlinkRight")) / 2;
      const jaw = score("jawOpen");
      const matrix = res.facialTransformationMatrixes?.[0];
      const pose = matrix ? headPoseFromMatrix(matrix.data) : { pitch: 0, yaw: 0, roll: 0 };
      const meta: CaptureMeta = {
        ear: (eyeAspectRatio(pts, LEFT_EYE) + eyeAspectRatio(pts, RIGHT_EYE)) / 2,
        blinkScore: blink,
        mar: mouthAspectRatio(pts),
        jawOpen: jaw,
        ...pose,
      };

      const regions: Record<Part, Region> = {
        oeil_d: regionFor("oeil_d", pts),
        oeil_g: regionFor("oeil_g", pts),
        bouche: regionFor("bouche", pts),
      };
      for (const part of ["oeil_d", "oeil_g", "bouche"] as Part[]) {
        const c = previewRefs.current[part];
        const ctx = c?.getContext("2d");
        if (c && ctx) drawRegion(ctx, video, regions[part], c.width);
      }

      // Étiquette proposée par le modèle de Google (scores 0–1). Entre les deux seuils = douteux.
      const eyes: EyeLabel =
        blink >= cfg.auto.closedMin ? "yeux_fermes" : blink <= cfg.auto.openMax ? "yeux_ouverts" : null;
      const mouth: MouthLabel =
        jaw >= cfg.auto.yawnMin ? "bouche_baillement" : jaw <= cfg.auto.normalMax ? "bouche_fermee" : null;

      // Classes à capturer sur cette image
      const wanted: { cls: ClassKey; burst: string }[] = [];
      if (cfg.mode === "manuel") {
        for (const [cls, burst] of heldRef.current) wanted.push({ cls, burst });
      } else if (cfg.recording) {
        if (cfg.autoTasks.yeux && eyes) wanted.push({ cls: eyes, burst: cfg.autoBurst });
        if (cfg.autoTasks.bouche && mouth) wanted.push({ cls: mouth, burst: cfg.autoBurst });
      }

      const colors: Record<Part, string | null> = { oeil_d: null, oeil_g: null, bouche: null };
      frame++;
      if (wanted.length > 0 && frame % cfg.everyN === 0) {
        if (!cfg.person.trim()) {
          setError("Indiquez le nom de la personne filmée avant de capturer.");
        } else if (Math.abs(pose.yaw) > 40) {
          setRejected((r) => ({ ...r, tete: r.tete + 1 }));
        } else {
          let any = false;
          for (const { cls, burst } of wanted) {
            const task = CLASSES[cls].task;
            const suggestion = task === "yeux" ? eyes : mouth;
            if (cfg.mode === "manuel" && cfg.rejectInconsistent && suggestion && suggestion !== cls) {
              setRejected((r) => ({ ...r, incoherent: r.incoherent + 1 }));
              continue;
            }
            const parts = PARTS_OF[task];
            if (parts.some((p) => isOutside(regions[p], w, h))) {
              setRejected((r) => ({ ...r, horsCadre: r.horsCadre + 1 }));
              continue;
            }
            if (inflightRef.current > 8) {
              setRejected((r) => ({ ...r, surcharge: r.surcharge + 1 }));
              continue;
            }
            const items = parts.map((part) => ({ cls, part, image: cropToDataUrl(video, regions[part]), meta }));
            parts.forEach((p) => (colors[p] = CLASSES[cls].color));
            void send(items, burst);
            any = true;
          }
          if (any) {
            tick();
            flashRef.current?.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 220 });
          }
        }
      }
      drawOverlay(regions, colors);

      if (now - lastUi > 150) {
        lastUi = now;
        setSuggest({ face: true, eyes, mouth, blink, jaw });
      }
    };
    step();
  }, [drawOverlay, landmarkerRef, send, tick]);

  // ---- Caméra -------------------------------------------------------------------
  const start = async () => {
    audioRef.current ??= new AudioContext();
    void audioRef.current.resume();
    if (!session.trim()) {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      setSession(`s${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`);
    }
    try {
      const stream = await openCamera({ width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setRunning(true);
      setError(null);
      loop();
    } catch (e) {
      setError(`Caméra inaccessible : ${(e as Error).message}`);
    }
  };

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    heldRef.current.clear();
    setHeld([]);
    setRecording(false);
    setRunning(false);
    drawOverlay(null, { oeil_d: null, oeil_g: null, bouche: null });
  }, [drawOverlay]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audioRef.current?.close();
    },
    [],
  );

  // ---- Clavier : maintenir O / F / N / B pour capturer en rafale ----------------
  const press = useCallback((cls: ClassKey) => {
    if (heldRef.current.has(cls)) return;
    heldRef.current.set(cls, newBurst(cls));
    setHeld([...heldRef.current.keys()]);
  }, []);
  const release = useCallback((cls: ClassKey) => {
    if (!heldRef.current.delete(cls)) return;
    setHeld([...heldRef.current.keys()]);
  }, []);

  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping(e) || e.repeat || !running || mode !== "manuel") return;
      const cls = KEY_TO_CLASS[e.key.toLowerCase()];
      if (cls) {
        e.preventDefault();
        press(cls);
      }
    };
    const up = (e: KeyboardEvent) => {
      const cls = KEY_TO_CLASS[e.key.toLowerCase()];
      if (cls) release(cls);
    };
    const blur = () => {
      heldRef.current.clear();
      setHeld([]);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [running, mode, press, release]);

  const toggleRecording = () => {
    if (!recording) setAutoBurst(newBurst("auto"));
    setRecording((r) => !r);
  };

  const makeSplit = async () => {
    setSplitMsg("Calcul…");
    const res = await fetch("/api/dataset/split", { method: "POST" });
    const data = await res.json();
    if (!res.ok) setSplitMsg(data.error);
    else {
      setSplitMsg(null);
      void refreshStats();
    }
  };

  const sessionTotal = Object.values(sessionCounts).reduce((a, b) => a + b, 0);
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
  const error2 = error ?? modelError;
  const persons = stats ? Object.entries(stats.persons).sort((a, b) => a[0].localeCompare(b[0])) : [];

  return (
    <div className="min-h-screen bg-base text-ink">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">Collecte et étiquetage des données</h1>
          <p className="text-xs text-muted">
            Préparer la base d’images pour le fine-tuning (version 2) · enregistrement dans le dossier <code>data/</code>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-line px-3 py-1 text-xs text-soft">
            {modelStatus === "loading" && "Chargement du modèle…"}
            {modelStatus === "error" && "Erreur"}
            {modelStatus === "ready" && `Modèle prêt (${delegate})`}
            {running && ` · ${fps} FPS`}
          </span>
          {!running ? (
            <button
              onClick={start}
              disabled={modelStatus !== "ready"}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              ▶ Démarrer la caméra
            </button>
          ) : (
            <button onClick={stop} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-white/10">
              ■ Arrêter
            </button>
          )}
        </div>
      </header>

      {error2 && (
        <div className="mx-6 mt-4 flex items-center justify-between rounded-lg border border-danger bg-danger/10 px-4 py-2 text-sm">
          <span>{error2}</span>
          <button onClick={() => setError(null)} className="text-xs underline">
            fermer
          </button>
        </div>
      )}

      <main className="grid gap-4 p-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* ================= Colonne gauche ================= */}
        <div className="flex flex-col gap-4">
          <Card title="1 · Qui est filmé ?">
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
                Personne (identifiant, sans nom complet)
                <input
                  value={person}
                  onChange={(e) => setPerson(e.target.value)}
                  placeholder="ex. p01"
                  className="rounded-lg border border-line bg-base px-3 py-2 text-sm text-white outline-none focus:border-brand"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
                Session
                <input
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                  placeholder="créée au démarrage"
                  className="rounded-lg border border-line bg-base px-3 py-2 text-sm text-white outline-none focus:border-brand"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
                Lumière
                <select
                  value={lighting}
                  onChange={(e) => setLighting(e.target.value as Lighting)}
                  className="rounded-lg border border-line bg-base px-3 py-2 text-sm text-white"
                >
                  <option value="jour">Jour / bonne lumière</option>
                  <option value="faible">Lumière faible</option>
                  <option value="nuit">Nuit</option>
                </select>
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-soft sm:col-span-2">
                <input type="checkbox" checked={glasses} onChange={(e) => setGlasses(e.target.checked)} className="accent-brand" />
                Porte des lunettes
              </label>
            </div>
          </Card>

          <Card className="overflow-hidden p-0">
            <div className="relative aspect-video w-full bg-black">
              <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
              <canvas ref={overlayRef} className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
              <div ref={flashRef} className="pointer-events-none absolute inset-0 bg-white opacity-0" />
              {!running && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-8 text-center text-soft">
                  <p className="text-lg font-semibold text-white">Caméra arrêtée</p>
                  <p className="max-w-md text-sm">
                    Renseignez la personne filmée, puis démarrez la caméra. Les cadres blancs montrent les zones découpées
                    (yeux et bouche).
                  </p>
                </div>
              )}
              {running && (
                <div className="absolute left-3 top-3 flex flex-wrap gap-2 text-xs font-semibold">
                  {!suggest.face && <span className="rounded-md bg-black/70 px-2 py-1">Aucun visage</span>}
                  {suggest.face && (
                    <>
                      <span
                        className="rounded-md px-2 py-1"
                        style={{ background: suggest.eyes ? CLASSES[suggest.eyes].color : "rgba(0,0,0,0.7)" }}
                      >
                        Google : {suggest.eyes ? CLASSES[suggest.eyes].label : "yeux douteux"} ({suggest.blink.toFixed(2)})
                      </span>
                      <span
                        className="rounded-md px-2 py-1"
                        style={{ background: suggest.mouth ? CLASSES[suggest.mouth].color : "rgba(0,0,0,0.7)" }}
                      >
                        {suggest.mouth ? CLASSES[suggest.mouth].label : "bouche douteuse"} ({suggest.jaw.toFixed(2)})
                      </span>
                    </>
                  )}
                </div>
              )}
              {running && mode === "auto" && recording && (
                <div className="absolute right-3 top-3 flex items-center gap-2 rounded-md bg-danger px-2 py-1 text-xs font-bold">
                  <span className="alert-flash inline-block h-2 w-2 rounded-full bg-white" /> ENREGISTREMENT AUTO
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-3">
                {(["oeil_d", "oeil_g", "bouche"] as Part[]).map((p) => (
                  <div key={p} className="flex flex-col items-center gap-1">
                    <canvas
                      ref={(el) => {
                        previewRefs.current[p] = el;
                      }}
                      width={96}
                      height={96}
                      className="h-16 w-16 rounded-md border border-line bg-black"
                    />
                    <span className="text-[10px] text-muted">
                      {p === "oeil_d" ? "œil droit" : p === "oeil_g" ? "œil gauche" : "bouche"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="max-w-xs text-xs text-muted">
                Images enregistrées : 96 × 96 px, redressées. Une capture toutes les {everyN} images vidéo.
              </p>
            </div>
          </Card>

          <Card title="2 · Étiqueter">
            <div className="mb-4 grid grid-cols-2 gap-2">
              {(
                [
                  ["manuel", "Manuel (clavier)", "Vous décidez de l’étiquette en maintenant une touche."],
                  ["auto", "Automatique (MediaPipe)", "Le modèle de Google étiquette seul ; les images douteuses sont ignorées."],
                ] as const
              ).map(([m, label, hint]) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setRecording(false);
                    heldRef.current.clear();
                    setHeld([]);
                  }}
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    mode === m ? "border-brand bg-brand/20" : "border-line hover:border-muted"
                  }`}
                >
                  <p className="text-sm font-semibold">{label}</p>
                  <p className="text-xs text-muted">{hint}</p>
                </button>
              ))}
            </div>

            {mode === "manuel" ? (
              <>
                <p className="mb-3 text-sm text-soft">
                  <b>Maintenez</b> la touche pendant que la personne prend la pose : les images partent en rafale. Vous
                  pouvez aussi maintenir le bouton à la souris.
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {CLASS_KEYS.map((cls) => {
                    const c = CLASSES[cls];
                    const on = held.includes(cls);
                    return (
                      <button
                        key={cls}
                        disabled={!running}
                        onPointerDown={() => press(cls)}
                        onPointerUp={() => release(cls)}
                        onPointerLeave={() => release(cls)}
                        className="select-none rounded-xl border-2 px-3 py-3 text-center transition disabled:opacity-40"
                        style={{ borderColor: c.color, background: on ? c.color : "transparent" }}
                      >
                        <span className="block font-mono text-2xl font-black">{c.key}</span>
                        <span className="text-xs">{c.label}</span>
                      </button>
                    );
                  })}
                </div>
                <label className="mt-3 flex items-center gap-2 text-xs text-soft">
                  <input
                    type="checkbox"
                    checked={rejectInconsistent}
                    onChange={(e) => setRejectInconsistent(e.target.checked)}
                    className="accent-brand"
                  />
                  Refuser une image si Google est sûr du contraire (ex. touche F mais yeux bien ouverts)
                </label>
              </>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-4">
                  <button
                    onClick={toggleRecording}
                    disabled={!running}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40 ${
                      recording ? "bg-danger" : "bg-brand"
                    }`}
                  >
                    {recording ? "■ Arrêter l’enregistrement" : "● Lancer l’enregistrement auto"}
                  </button>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={autoTasks.yeux}
                      onChange={(e) => setAutoTasks((t) => ({ ...t, yeux: e.target.checked }))}
                      className="accent-brand"
                    />
                    yeux
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={autoTasks.bouche}
                      onChange={(e) => setAutoTasks((t) => ({ ...t, bouche: e.target.checked }))}
                      className="accent-brand"
                    />
                    bouche
                  </label>
                </div>
                <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Slider label="Yeux fermés si eyeBlink ≥" value={auto.closedMin} min={0.3} max={0.95} step={0.05} onChange={(v) => setAuto((a) => ({ ...a, closedMin: v }))} />
                  <Slider label="Yeux ouverts si eyeBlink ≤" value={auto.openMax} min={0.05} max={0.5} step={0.05} onChange={(v) => setAuto((a) => ({ ...a, openMax: v }))} />
                  <Slider label="Bâillement si jawOpen ≥" value={auto.yawnMin} min={0.2} max={0.9} step={0.05} onChange={(v) => setAuto((a) => ({ ...a, yawnMin: v }))} />
                  <Slider label="Bouche normale si jawOpen ≤" value={auto.normalMax} min={0.02} max={0.3} step={0.01} onChange={(v) => setAuto((a) => ({ ...a, normalMax: v }))} />
                </div>
                <p className="mt-3 text-xs text-muted">
                  Entre les deux seuils, l’image est jugée douteuse et n’est pas enregistrée. Vérifiez quand même les
                  images dans la galerie plus bas : le modèle de Google peut se tromper.
                </p>
              </>
            )}

            <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-soft">
                <span className="flex justify-between">
                  <span>Garder 1 image vidéo sur</span>
                  <span className="font-mono text-white">{everyN}</span>
                </span>
                <input type="range" min={1} max={15} step={1} value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} className="accent-brand" />
                <span className="text-faint">Plus haut = images moins répétitives (conseillé : 5 à 10).</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-soft">
                <input type="checkbox" checked={tickSound} onChange={(e) => setTickSound(e.target.checked)} className="accent-brand" />
                Petit bip à chaque capture (utile les yeux fermés)
              </label>
            </div>
          </Card>

          <Card title="Protocole conseillé (par personne)">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-soft">
              <li>
                <b>O</b> · yeux ouverts, regard vers la route : 30 s en bougeant un peu la tête.
              </li>
              <li>
                <b>F</b> · yeux fermés, détendus : 4 × 10 s (le bip confirme les captures).
              </li>
              <li>
                <b>B</b> · 4 à 5 vrais bâillements (ou bouche grande ouverte), <b>N</b> · bouche normale / en parlant : 30 s.
              </li>
              <li>Recommencer avec une autre lumière, avec et sans lunettes.</li>
              <li>Au moins 3 personnes différentes pour pouvoir séparer entraînement / validation / test.</li>
            </ol>
          </Card>
        </div>

        {/* ================= Colonne droite ================= */}
        <div className="flex flex-col gap-4">
          <Card title="Cette séance">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CLASS_KEYS.map((cls) => (
                <div key={cls} className="rounded-lg bg-raised px-2 py-2 text-center">
                  <p className="text-[11px]" style={{ color: CLASSES[cls].color }}>
                    {CLASSES[cls].label}
                  </p>
                  <p className="font-mono text-xl">{sessionCounts[cls]}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              {sessionTotal} images enregistrées · {rejectedTotal} refusées
              {rejectedTotal > 0 &&
                ` (incohérentes ${rejected.incoherent}, hors cadre ${rejected.horsCadre}, tête tournée ${rejected.tete}, surcharge ${rejected.surcharge})`}
            </p>
            <button
              onClick={undoLastBurst}
              disabled={sessionTotal === 0}
              className="mt-3 rounded-lg border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-40"
            >
              ↶ Annuler la dernière rafale
            </button>

            {recent.length > 0 && (
              <div className="mt-4 grid grid-cols-8 gap-1">
                {recent.map((r) => (
                  <button
                    key={r.file}
                    onClick={() => deleteFiles([r.file])}
                    title="Cliquer pour supprimer"
                    className="group relative"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt={CLASSES[r.cls].label} className="aspect-square w-full rounded" />
                    <span className="absolute inset-x-0 bottom-0 h-1 rounded-b" style={{ background: CLASSES[r.cls].color }} />
                    <span className="absolute inset-0 hidden items-center justify-center rounded bg-black/60 text-lg group-hover:flex">
                      ✕
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card title="3 · Base de données (dossier data/)">
            <div className="flex flex-col gap-3">
              {CLASS_KEYS.map((cls) => {
                const n = stats?.classes[cls] ?? 0;
                return (
                  <div key={cls}>
                    <div className="flex justify-between text-xs">
                      <span style={{ color: CLASSES[cls].color }}>
                        {CLASSES[cls].label} <span className="text-faint">· data/{CLASSES[cls].dir}</span>
                      </span>
                      <span className="font-mono">
                        {n} / {TARGET_PER_CLASS}
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-white/10">
                      <div
                        className="h-2 rounded-full"
                        style={{ width: `${Math.min(100, (n / TARGET_PER_CLASS) * 100)}%`, background: CLASSES[cls].color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted">
              {stats ? `${stats.total} images · ${persons.length} personne(s)` : "Chargement…"} · chaque œil compte comme
              une image.
            </p>

            {persons.length > 0 && (
              <table className="mt-3 w-full text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 text-left font-normal">Personne</th>
                    {CLASS_KEYS.map((cls) => (
                      <th key={cls} className="py-1 text-right font-normal" style={{ color: CLASSES[cls].color }}>
                        {CLASSES[cls].key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {persons.map(([p, c]) => (
                    <tr key={p} className="border-t border-white/5">
                      <td className="py-1">{p}</td>
                      {CLASS_KEYS.map((cls) => (
                        <td key={cls} className="py-1 text-right font-mono">
                          {c[cls]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {stats && <p className="mt-3 break-all text-[11px] text-faint">Dossier : {stats.dataDir}</p>}
          </Card>

          <Card title="4 · Préparer l’entraînement">
            <p className="text-sm text-soft">
              Crée <code>data/split.csv</code> : 70 % entraînement, 15 % validation, 15 % test. Une même personne reste
              dans un seul ensemble.
            </p>
            <button
              onClick={makeSplit}
              disabled={!stats || stats.total === 0}
              className="mt-3 rounded-lg bg-mouth px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-40"
            >
              Créer le découpage
            </button>
            {splitMsg && <p className="mt-2 text-sm text-danger">{splitMsg}</p>}
            {stats?.split && (
              <div className="mt-3 text-xs">
                <p className="text-muted">
                  Dernier découpage : {new Date(stats.split.createdAt).toLocaleString("fr-FR")} · {stats.split.mode}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {(["train", "val", "test"] as const).map((s) => (
                    <div key={s} className="rounded-lg bg-raised p-2">
                      <p className="font-semibold">
                        {s === "train" ? "Entraînement" : s === "val" ? "Validation" : "Test"}
                      </p>
                      <p className="font-mono text-lg">{stats.split!.sets[s].images}</p>
                      <p className="truncate text-muted">{stats.split!.sets[s].persons.join(", ") || "–"}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-faint">
                  L’augmentation (rotation, luminosité, flou, miroir) se fera au moment de l’entraînement.
                </p>
              </div>
            )}
          </Card>
        </div>

        {/* ================= Vérification ================= */}
        <Card title="5 · Vérifier et nettoyer la base" className="xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {CLASS_KEYS.map((cls) => (
              <button
                key={cls}
                onClick={() => {
                  setReviewCls(cls);
                  void loadReview(cls);
                }}
                className="rounded-lg border px-3 py-1.5 text-sm"
                style={{
                  borderColor: CLASSES[cls].color,
                  background: reviewCls === cls && reviewFiles.length ? CLASSES[cls].color : "transparent",
                }}
              >
                {CLASSES[cls].label}
              </button>
            ))}
            <button
              onClick={() => loadReview(reviewCls)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-white/10"
            >
              ⟳ Afficher
            </button>
            {selected.size > 0 && (
              <button
                onClick={() => deleteFiles([...selected])}
                className="rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold"
              >
                Supprimer {selected.size} image(s)
              </button>
            )}
            <span className="text-xs text-muted">
              Cliquez sur les images mal étiquetées pour les sélectionner, puis supprimez-les.
            </span>
          </div>
          {reviewFiles.length === 0 ? (
            <p className="text-sm text-faint">Choisissez une classe pour afficher ses images (les plus récentes d’abord).</p>
          ) : (
            <>
              <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-10 lg:grid-cols-15">
                {reviewFiles.map((f) => {
                  const on = selected.has(f);
                  return (
                    <button
                      key={f}
                      onClick={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (n.has(f)) n.delete(f);
                          else n.add(f);
                          return n;
                        })
                      }
                      className={`relative rounded ${on ? "ring-2 ring-danger" : ""}`}
                      title={f}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/dataset/image?file=${encodeURIComponent(f)}`}
                        alt=""
                        loading="lazy"
                        className={`aspect-square w-full rounded ${on ? "opacity-40" : ""}`}
                      />
                      {on && <span className="absolute inset-0 flex items-center justify-center text-xl">✕</span>}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-muted">
                {reviewFiles.length} affichées sur {reviewTotal}
                {reviewFiles.length < reviewTotal && (
                  <button onClick={() => loadReview(reviewCls, reviewFiles.length)} className="ml-3 underline">
                    afficher plus
                  </button>
                )}
              </p>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}

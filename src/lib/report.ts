"use client";

// Rapport PDF de fin de trajet (A4, graphiques vectoriels, généré dans le navigateur avec jsPDF).
// Données : la session enregistrée (logStore) + le journal du boîtier pendant le trajet.

import type { jsPDF as JsPDF } from "jspdf";
import { FATIGUE_BANDS, LEVELS, type EventKind, type Level } from "./engine";
import type { Logs, SessionLog } from "./logStore";

// ---------------------------------------------------------------------------
// Couleurs (page claire pour l'impression ; mêmes couleurs de niveau que la plateforme)
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** Couleur adoucie sur fond blanc (a = 1 : couleur pleine). */
const tint = (h: string, a: number): RGB => hex(h).map((c) => Math.round(255 - (255 - c) * a)) as RGB;

const P = {
  dark: "#0b0f17",
  dark2: "#161d2b",
  brand: "#2a78d6",
  ink: "#111827",
  text: "#374151",
  muted: "#6b7280",
  faint: "#9ca3af",
  line: "#e5e7eb",
  soft: "#f4f6fa",
};
const LV = ["#0ca30c", "#fab219", "#ec835a", "#d03b3b"];
/** Variante foncée pour écrire en couleur sur fond blanc (le jaune pur est illisible). */
const LV_TEXT = ["#0a7f0a", "#a86f00", "#c2552b", "#b42727"];

// ---------------------------------------------------------------------------
// Analyse de la session
// ---------------------------------------------------------------------------
const SIGNS: { kind: EventKind; name: string; desc: string }[] = [
  {
    kind: "closure",
    name: "Fermetures prolongées des yeux",
    desc: "Yeux fermés plus d'une seconde, bien plus long qu'un clignement (0,1 à 0,4 s). C'est le premier signe du micro-sommeil.",
  },
  {
    kind: "yawn",
    name: "Bâillements",
    desc: "Bouche grande ouverte plus de 1,5 s. Plusieurs bâillements rapprochés traduisent un manque de sommeil.",
  },
  {
    kind: "nod",
    name: "Hochements de tête",
    desc: "La tête tombe vers l'avant puis se relève : le conducteur lutte contre l'endormissement.",
  },
  {
    kind: "distraction",
    name: "Regard détourné",
    desc: "Tête tournée plus de 2 s : l'attention n'est plus sur la route (téléphone, passager...).",
  },
  {
    kind: "faceLost",
    name: "Visage perdu",
    desc: "La caméra ne voit plus le visage : tête très basse, hors du champ ou lumière insuffisante.",
  },
];

const RISKS = [
  { label: "FAIBLE", color: LV[0], text: LV_TEXT[0] },
  { label: "MODÉRÉ", color: LV[1], text: LV_TEXT[1] },
  { label: "ÉLEVÉ", color: LV[2], text: LV_TEXT[2] },
  { label: "CRITIQUE", color: LV[3], text: LV_TEXT[3] },
];

function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
const fmtTime = (at: number) => new Date(at).toLocaleTimeString("fr-FR");
const fmtHm = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (at: number) =>
  new Date(at).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** Index de la zone de fatigue (0 à 3) d'un score. */
const bandIndex = (v: number) => {
  let i = 0;
  FATIGUE_BANDS.forEach((b, k) => {
    if (v >= b.min) i = k;
  });
  return i;
};
const pct = (x: number) => `${Math.round(x * 100)} %`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n > 1 ? many : one}`;

export function analyseSession(s: SessionLog, logs: Logs) {
  const end = Math.max(s.end, s.start + 1000);
  const durationMs = end - s.start;
  const levelTotal = s.levelMs.reduce((a, b) => a + b, 0) || 1;
  const levelPct = s.levelMs.map((ms) => ms / levelTotal);

  // Épisodes : une entrée en alerte (>= 2) ou en danger (3) compte une fois.
  let alertEp = 0;
  let dangerEp = 0;
  let prev: Level = 0;
  for (const p of s.timeline) {
    if (p.level >= 2 && prev < 2) alertEp++;
    if (p.level === 3 && prev < 3) dangerEp++;
    prev = p.level;
  }

  const signs = Object.fromEntries(SIGNS.map((x) => [x.kind, 0])) as Record<EventKind, number>;
  for (const e of s.events) if (e.kind in signs) signs[e.kind]++;
  const stoppedByDriver = s.events.filter((e) => e.kind === "level" && e.message.startsWith("Alerte arrêtée")).length;
  const calibration = [...s.events].reverse().find((e) => e.kind === "calibration")?.message ?? null;

  const f = s.fatigue ?? [];
  const fAvg = f.length ? f.reduce((a, x) => a + x.v, 0) / f.length : null;
  const fMax = f.length ? f.reduce((m, x) => (x.v > m.v ? x : m), f[0]) : null;
  const fOver55 = f.length ? f.filter((x) => x.v >= 55).length / f.length : null;

  // Boîtier : ce qui s'est passé pendant le trajet (+ 1 min après, pour la fin du SOS).
  const inWin = (at: number) => at >= s.start - 2000 && at <= end + 60000;
  const box = logs.box.filter((b) => inWin(b.at));
  const acks = logs.acks.filter((a) => inWin(a.at));
  const latency = logs.latency.filter((l) => inWin(l.at)).map((l) => l.ms);
  const reactions = acks.map((a) => a.reactionMs).filter((x): x is number => x !== null);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const boxStats = {
    connected: box.length > 0 || latency.length > 0,
    acks: acks.filter((a) => a.type === "alerte").length,
    reactionAvg: avg(reactions),
    sos: box.filter((b) => b.evenement === "SOS_ENVOYE").length,
    pauses: box.filter((b) => b.evenement === "PAUSE_OK").length,
    latencyAvg: avg(latency),
  };

  const risk: 0 | 1 | 2 | 3 =
    boxStats.sos > 0 || dangerEp >= 2
      ? 3
      : dangerEp >= 1 || (fAvg ?? 0) >= 55
        ? 2
        : alertEp >= 1 || (fAvg ?? 0) >= 30 || levelPct[0] < 0.85
          ? 1
          : 0;

  return {
    session: s,
    end,
    durationMs,
    levelPct,
    alertEp,
    dangerEp,
    signs,
    stoppedByDriver,
    calibration,
    fatigue: f,
    fAvg,
    fMax,
    fOver55,
    boxStats,
    risk,
  };
}
type Analysis = ReturnType<typeof analyseSession>;

function verdictText(a: Analysis) {
  const found = SIGNS.filter((x) => a.signs[x.kind] > 0).map((x) => `${x.name.toLowerCase()} (${a.signs[x.kind]})`);
  switch (a.risk) {
    case 0:
      return `Aucun signe de somnolence important pendant ce trajet de ${fmtDur(a.durationMs)}. Le conducteur est resté à l'état normal ${pct(a.levelPct[0])} du temps. Continuez à faire une pause toutes les deux heures.`;
    case 1:
      return `Quelques signes de fatigue sont apparus${found.length ? ` : ${found.join(", ")}` : ""}. Rien de grave pour l'instant, mais une pause de 15 minutes est conseillée si le trajet continue.`;
    case 2:
      return `Le niveau Danger a été atteint ${plural(a.dangerEp, "fois", "fois")} : le conducteur a gardé les yeux fermés ou la tête tombée trop longtemps. Une vraie pause (20 minutes de sieste) est nécessaire avant de reprendre la route.`;
    default:
      return `Situation critique : ${plural(a.dangerEp, "épisode")} de danger${a.boxStats.sos ? ` et ${plural(a.boxStats.sos, "SOS envoyé", "SOS envoyés")} aux proches` : ""}. Le conducteur ne doit pas reprendre le volant sans s'être reposé.`;
  }
}

function recommendations(a: Analysis): { title: string; text: string; level: Level }[] {
  const r: { title: string; text: string; level: Level }[] = [];
  if (a.dangerEp > 0)
    r.push({
      title: "S'arrêter et dormir 20 minutes",
      text: "Un endormissement au volant a été détecté. Seul le sommeil fait disparaître la fatigue : le café ou la musique ne font que la masquer quelques minutes.",
      level: 3,
    });
  if (a.signs.yawn >= 3)
    r.push({
      title: "Rattraper le manque de sommeil",
      text: `${a.signs.yawn} bâillements pendant le trajet : signe d'une dette de sommeil. Évitez de conduire entre 2 h et 5 h du matin et après un repas copieux.`,
      level: 2,
    });
  if (a.signs.closure >= 3)
    r.push({
      title: "Surveiller les fermetures des yeux",
      text: `${a.signs.closure} fermetures prolongées : les paupières deviennent lourdes. Arrêtez-vous dès la prochaine aire de repos.`,
      level: 2,
    });
  if (a.signs.distraction >= 1)
    r.push({
      title: "Garder les yeux sur la route",
      text: "Le regard a été détourné plusieurs secondes. Rangez le téléphone et réglez le GPS avant de partir.",
      level: 1,
    });
  if (a.signs.faceLost >= 2)
    r.push({
      title: "Vérifier la caméra",
      text: "Le visage a été perdu plusieurs fois. Placez la caméra face au conducteur, à hauteur des yeux, avec un éclairage suffisant.",
      level: 1,
    });
  if (a.boxStats.reactionAvg !== null && a.boxStats.reactionAvg > 3000)
    r.push({
      title: "Temps de réaction trop long",
      text: `Il a fallu en moyenne ${(a.boxStats.reactionAvg / 1000).toFixed(1)} s pour appuyer sur le bouton après une alerte. Un conducteur reposé réagit en moins de 2 s.`,
      level: 2,
    });
  if (a.durationMs > 2 * 3600 * 1000)
    r.push({
      title: "Faire des pauses régulières",
      text: "Le trajet a duré plus de deux heures. La sécurité routière conseille une pause de 15 minutes toutes les deux heures.",
      level: 1,
    });
  if (!r.length)
    r.push({
      title: "Bon trajet",
      text: "Aucun comportement à risque. Gardez les bonnes habitudes : nuit complète avant de partir et pause toutes les deux heures.",
      level: 0,
    });
  return r;
}

// ---------------------------------------------------------------------------
// Mise en page
// ---------------------------------------------------------------------------
const PAGE_W = 210;
const PAGE_H = 297;
const M = 14; // marge
const W = PAGE_W - 2 * M;
const BOTTOM = PAGE_H - 16;

/** Les polices standard du PDF ne connaissent que le Latin-1 : on remplace le reste. */
function clean(s: string) {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/œ/g, "oe")
    .replace(/[^\x00-\xFF]/g, "");
}

class Writer {
  y = M;
  constructor(
    readonly doc: JsPDF,
    readonly headerText: string,
  ) {}

  fill(c: string | RGB) {
    const [r, g, b] = typeof c === "string" ? hex(c) : c;
    this.doc.setFillColor(r, g, b);
  }
  stroke(c: string | RGB) {
    const [r, g, b] = typeof c === "string" ? hex(c) : c;
    this.doc.setDrawColor(r, g, b);
  }
  color(c: string | RGB) {
    const [r, g, b] = typeof c === "string" ? hex(c) : c;
    this.doc.setTextColor(r, g, b);
  }
  font(size: number, style: "normal" | "bold" = "normal", c: string | RGB = P.text) {
    this.doc.setFont("helvetica", style);
    this.doc.setFontSize(size);
    this.color(c);
  }
  text(s: string, x: number, y: number, opts?: { align?: "left" | "center" | "right" }) {
    this.doc.text(clean(s), x, y, opts);
  }
  /** Paragraphe sur plusieurs lignes ; renvoie la hauteur utilisée. */
  para(s: string, x: number, y: number, w: number, size = 9, c: string = P.text, style: "normal" | "bold" = "normal") {
    this.font(size, style, c);
    const lines = this.doc.splitTextToSize(clean(s), w) as string[];
    const lh = size * 0.3528 * 1.42;
    lines.forEach((l, i) => this.doc.text(l, x, y + i * lh));
    return lines.length * lh;
  }
  paraHeight(s: string, w: number, size = 9) {
    this.doc.setFontSize(size);
    return (this.doc.splitTextToSize(clean(s), w) as string[]).length * size * 0.3528 * 1.42;
  }

  /** Nouvelle page si la hauteur demandée ne tient pas. */
  ensure(h: number) {
    if (this.y + h <= BOTTOM) return;
    this.doc.addPage();
    this.font(8, "normal", P.muted);
    this.text(this.headerText, M, 10);
    this.stroke(P.line);
    this.doc.setLineWidth(0.2);
    this.doc.line(M, 12.5, PAGE_W - M, 12.5);
    this.y = 20;
  }

  /** Titre de section numéroté + phrase d'explication. */
  /** bodyMin : hauteur du contenu qui doit rester sur la même page que le titre. */
  section(n: number, title: string, intro?: string, bodyMin = 30) {
    const introH = intro ? this.paraHeight(intro, W, 9) + 2 : 0;
    this.ensure(14 + introH + bodyMin);
    this.y += 4;
    this.fill(P.brand);
    this.doc.roundedRect(M, this.y - 4.6, 7, 7, 1.6, 1.6, "F");
    this.font(9, "bold", "#ffffff");
    this.text(String(n), M + 3.5, this.y + 0.6, { align: "center" });
    this.font(13, "bold", P.ink);
    this.text(title, M + 10, this.y + 0.8);
    this.y += 7;
    if (intro) {
      this.y += this.para(intro, M, this.y, W, 9, P.muted) + 1;
    }
  }

  footer(generatedAt: string) {
    const n = this.doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      this.doc.setPage(i);
      this.stroke(P.line);
      this.doc.setLineWidth(0.2);
      this.doc.line(M, PAGE_H - 11, PAGE_W - M, PAGE_H - 11);
      this.font(7.5, "normal", P.faint);
      this.text(`DriveAlert AI · Rapport de trajet · généré le ${generatedAt}`, M, PAGE_H - 7);
      this.text(`Page ${i} / ${n}`, PAGE_W - M, PAGE_H - 7, { align: "right" });
    }
  }
}

/** Polygone à partir de points absolus (jsPDF attend des déplacements relatifs). */
function polygon(doc: JsPDF, pts: [number, number][], style: "F" | "S", closed: boolean) {
  if (pts.length < 2) return;
  const d = pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]);
  doc.lines(d, pts[0][0], pts[0][1], [1, 1], style, closed);
}

// ---------------------------------------------------------------------------
// Blocs du rapport
// ---------------------------------------------------------------------------
function drawCover(w: Writer, a: Analysis) {
  const { doc } = w;
  const s = a.session;
  w.fill(P.dark);
  doc.rect(0, 0, PAGE_W, 50, "F");
  w.fill(P.dark2);
  doc.circle(PAGE_W - 18, 6, 34, "F");
  // Logo
  w.fill(P.brand);
  doc.roundedRect(M, 11, 9, 9, 2.2, 2.2, "F");
  w.fill("#ffffff");
  doc.circle(M + 4.5, 15.5, 1.6, "F");
  w.font(10, "bold", "#ffffff");
  w.text("DriveAlert AI", M + 12, 17.2);
  w.font(8, "normal", tint("#ffffff", 0.6));
  w.text("Détection de somnolence au volant", M + 12, 21);

  w.font(24, "bold", "#ffffff");
  w.text("Rapport de trajet", M, 35);
  w.font(10, "normal", tint("#ffffff", 0.72));
  const date = fmtDate(s.start);
  w.text(`${date.charAt(0).toUpperCase()}${date.slice(1)} · ${fmtHm(s.start)} - ${fmtHm(a.end)}`, M, 42.5);

  // Pastille version
  const version = s.variant === "v2" ? "V2 · Mon modèle (MobileNetV2)" : "V1 · Modèle de Google (MediaPipe)";
  w.font(8, "bold", "#ffffff");
  const vw = doc.getTextWidth(clean(version)) + 8;
  w.fill(P.brand);
  doc.roundedRect(PAGE_W - M - vw, 13, vw, 7, 3.5, 3.5, "F");
  w.text(version, PAGE_W - M - vw / 2, 17.6, { align: "center" });
  w.y = 60;
}

function drawVerdict(w: Writer, a: Analysis) {
  const { doc } = w;
  const r = RISKS[a.risk];
  const text = verdictText(a);
  const textW = W - 58;
  const h = Math.max(36, w.paraHeight(text, textW, 9.5) + 20);
  w.fill(tint(r.color, 0.1));
  doc.roundedRect(M, w.y, W, h, 3, 3, "F");
  w.fill(r.color);
  doc.roundedRect(M, w.y, 2.2, h, 1.1, 1.1, "F");

  // Score moyen dans un anneau
  const cx = M + 25;
  const cy = w.y + h / 2;
  const score = a.fAvg !== null ? Math.round(a.fAvg) : null;
  const ring = score !== null ? LV[bandIndex(score)] : P.faint;
  w.stroke(tint(ring, 0.25));
  doc.setLineWidth(2.4);
  doc.circle(cx, cy, 13, "S");
  if (score !== null) {
    // Arc proportionnel au score
    w.stroke(ring);
    const steps = Math.max(2, Math.round((score / 100) * 60));
    const pts: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const ang = -Math.PI / 2 + (i / 60) * Math.PI * 2;
      pts.push([cx + 13 * Math.cos(ang), cy + 13 * Math.sin(ang)]);
    }
    polygon(doc, pts, "S", false);
  }
  doc.setLineWidth(0.2);
  w.font(17, "bold", P.ink);
  w.text(score !== null ? String(score) : "-", cx, cy + 1.5, { align: "center" });
  w.font(6.5, "normal", P.muted);
  w.text(score !== null ? "fatigue moy. /100" : "score indisponible", cx, cy + 6, { align: "center" });

  const tx = M + 48;
  w.font(8, "bold", P.muted);
  w.text("NIVEAU DE RISQUE DU TRAJET", tx, w.y + 9);
  w.font(16, "bold", r.text);
  w.text(r.label, tx, w.y + 16);
  w.para(text, tx, w.y + 22.5, textW, 9.5, P.text);
  w.y += h + 6;
}

function drawKpis(w: Writer, a: Analysis) {
  const { doc } = w;
  const tiles: { label: string; value: string; sub: string; accent: string }[] = [
    { label: "Durée surveillée", value: fmtDur(a.durationMs), sub: `${fmtHm(a.session.start)} -> ${fmtHm(a.end)}`, accent: P.brand },
    {
      label: "Temps à l'état normal",
      value: pct(a.levelPct[0]),
      sub: "niveau 0, conducteur éveillé",
      accent: LV[0],
    },
    {
      label: "Fatigue maximale",
      value: a.fMax ? `${a.fMax.v} / 100` : "-",
      sub: a.fMax ? `atteinte à ${fmtTime(a.fMax.at)}` : "non mesurée",
      accent: a.fMax ? LV[bandIndex(a.fMax.v)] : P.faint,
    },
    {
      label: "Fatigue >= 55",
      value: a.fOver55 !== null ? pct(a.fOver55) : "-",
      sub: "du temps en fatigue marquée",
      accent: LV[2],
    },
    { label: "Épisodes d'alerte", value: String(a.alertEp), sub: "passages au niveau 2 ou 3", accent: LV[2] },
    { label: "Épisodes de danger", value: String(a.dangerEp), sub: "passages au niveau 3", accent: LV[3] },
    { label: "Bâillements", value: String(a.signs.yawn), sub: "bouche ouverte > 1,5 s", accent: LV[1] },
    {
      label: "Yeux fermés longtemps",
      value: String(a.signs.closure),
      sub: "fermetures > 1 s",
      accent: LV[2],
    },
  ];
  const cols = 4;
  const gap = 4;
  const tw = (W - gap * (cols - 1)) / cols;
  const th = 23;
  w.ensure(th * 2 + gap + 4);
  tiles.forEach((t, i) => {
    const x = M + (i % cols) * (tw + gap);
    const y = w.y + Math.floor(i / cols) * (th + gap);
    w.fill(P.soft);
    doc.roundedRect(x, y, tw, th, 2.5, 2.5, "F");
    w.fill(t.accent);
    doc.circle(x + 5, y + 6.2, 1.3, "F");
    w.font(7.5, "normal", P.muted);
    w.text(t.label, x + 8, y + 7.2);
    w.font(15, "bold", P.ink);
    w.text(t.value, x + 4, y + 15.5);
    w.font(7, "normal", P.muted);
    w.text(t.sub, x + 4, y + 20);
  });
  w.y += th * 2 + gap + 4;
}

function drawLevelSplit(w: Writer, a: Analysis) {
  const { doc } = w;
  w.section(
    1,
    "Répartition du temps par niveau d'alerte",
    "Chaque image de la caméra reçoit un niveau de 0 (normal) à 3 (danger). La barre montre la part du trajet passée à chaque niveau : plus le vert domine, plus le conducteur était éveillé.",
  );
  w.ensure(32);
  const barH = 9;
  let x = M;
  a.levelPct.forEach((p, l) => {
    const sw = p * W;
    if (sw < 0.3) return;
    w.fill(LV[l]);
    doc.roundedRect(x, w.y, Math.max(sw - 0.8, 0.4), barH, 1.6, 1.6, "F");
    if (sw > 14) {
      w.font(8, "bold", l === 1 ? P.ink : "#ffffff");
      w.text(pct(p), x + sw / 2, w.y + 5.9, { align: "center" });
    }
    x += sw;
  });
  w.y += barH + 6;
  const colW = W / 4;
  ([0, 1, 2, 3] as Level[]).forEach((l) => {
    const cx = M + l * colW;
    w.fill(LV[l]);
    doc.roundedRect(cx, w.y - 2.8, 3.2, 3.2, 0.8, 0.8, "F");
    w.font(8.5, "bold", P.ink);
    w.text(`${l} · ${LEVELS[l].name}`, cx + 5, w.y);
    w.font(8, "normal", P.muted);
    w.text(`${fmtDur(a.session.levelMs[l])} · ${pct(a.levelPct[l])}`, cx + 5, w.y + 4.4);
    w.font(7, "normal", P.faint);
    w.text(LEVELS[l].hint, cx + 5, w.y + 8.4);
  });
  w.y += 14;
}

function drawTripSheet(w: Writer, a: Analysis) {
  const { doc } = w;
  const b = a.boxStats;
  w.section(2, "Fiche du trajet", "Informations générales et réglages utilisés pendant la surveillance.", 44);
  const rows: [string, string][] = [
    ["Début", `${fmtDate(a.session.start)} à ${fmtTime(a.session.start)}`],
    ["Fin", `${fmtTime(a.end)} (${fmtDur(a.durationMs)} de surveillance)`],
    ["Détection", a.session.variant === "v2" ? "V2 · mon modèle MobileNetV2 (yeux, bouche)" : "V1 · MediaPipe de Google (EAR, MAR, tête)"],
    ["Calibration", a.calibration ? a.calibration.replace(/^Calibration /, "") : "non effectuée"],
    [
      "Boîtier IoT",
      b.connected
        ? `connecté${b.latencyAvg !== null ? ` · latence moyenne ${Math.round(b.latencyAvg)} ms` : ""}`
        : "non connecté",
    ],
    ["Réponses du conducteur", plural(Math.max(b.acks, a.stoppedByDriver), "alerte arrêtée", "alertes arrêtées")],
    ["Seuils yeux fermés", "1 s -> niveau 2 (alerte) · 2 s -> niveau 3 (danger)"],
    ["SOS WhatsApp", "si le niveau 3 reste sans réponse pendant 5 s"],
  ];
  const colW = (W - 6) / 2;
  const rowH = 9.5;
  const h = Math.ceil(rows.length / 2) * rowH + 3;
  w.ensure(h);
  w.stroke(P.line);
  doc.setLineWidth(0.25);
  doc.roundedRect(M, w.y, W, h, 2.5, 2.5, "S");
  rows.forEach(([k, v], i) => {
    const x = M + (i % 2) * (colW + 6) + 4;
    const y = w.y + 2 + Math.floor(i / 2) * rowH;
    if (i >= 2 && i % 2 === 0) {
      w.stroke(P.line);
      doc.line(M + 3, y - 0.2, M + W - 3, y - 0.2);
    }
    w.font(7, "normal", P.muted);
    w.text(k.toUpperCase(), x, y + 3.6);
    w.font(8.5, "normal", P.ink);
    const line = (doc.splitTextToSize(clean(v), colW - 6) as string[])[0];
    doc.text(line, x, y + 7.6);
  });
  w.y += h + 4;
}

function drawFatigueChart(w: Writer, a: Analysis) {
  const { doc } = w;
  w.section(
    3,
    "Évolution de la fatigue pendant le trajet",
    "Le score de fatigue (0 à 100) combine la durée des fermetures des yeux, le PERCLOS (part du temps yeux fermés), les bâillements, les hochements de tête et le rythme des clignements. Il monte vite quand un signe apparaît et redescend lentement : la fatigue ne disparaît pas en quelques secondes. La bande du bas indique le niveau d'alerte décidé à chaque instant.",
    (a.fatigue.length >= 2 ? 52 : 0) + 26,
  );
  const t0 = a.session.start;
  const t1 = a.end;
  const labelW = 9;
  const cx = M + labelW;
  const cw = W - labelW;
  const hasScore = a.fatigue.length >= 2;
  const ch = hasScore ? 52 : 0;
  w.ensure(ch + 26);
  const top = w.y + 2;
  const xOf = (at: number) => cx + ((at - t0) / (t1 - t0)) * cw;
  const yOf = (v: number) => top + ch - (v / 100) * ch;

  if (hasScore) {
    // Zones de fatigue en fond
    FATIGUE_BANDS.forEach((b, i) => {
      const hi = i < FATIGUE_BANDS.length - 1 ? FATIGUE_BANDS[i + 1].min : 100;
      w.fill(tint(LV[b.level], 0.09));
      doc.rect(cx, yOf(hi), cw, yOf(b.min) - yOf(hi), "F");
    });
    // Graduations
    [0, 30, 55, 80, 100].forEach((v) => {
      w.stroke(P.line);
      doc.setLineWidth(0.15);
      doc.line(cx, yOf(v), cx + cw, yOf(v));
      w.font(6.5, "normal", P.faint);
      w.text(String(v), cx - 1.5, yOf(v) + 1.1, { align: "right" });
    });
    // Courbe (au plus ~400 points)
    const step = Math.max(1, Math.ceil(a.fatigue.length / 400));
    const pts: [number, number][] = a.fatigue
      .filter((_, i) => i % step === 0 || i === a.fatigue.length - 1)
      .map((p) => [xOf(p.at), yOf(p.v)]);
    const area: [number, number][] = [[pts[0][0], yOf(0)], ...pts, [pts[pts.length - 1][0], yOf(0)]];
    w.fill(tint(P.brand, 0.16));
    polygon(doc, area, "F", true);
    w.stroke(P.brand);
    doc.setLineWidth(0.55);
    polygon(doc, pts, "S", false);
    // Noms des zones (après la courbe pour rester lisibles)
    FATIGUE_BANDS.forEach((b, i) => {
      const hi = i < FATIGUE_BANDS.length - 1 ? FATIGUE_BANDS[i + 1].min : 100;
      w.font(6.3, "bold", LV_TEXT[b.level]);
      const lw = doc.getTextWidth(clean(b.label)) + 3;
      w.fill("#ffffff");
      doc.roundedRect(cx + 1.2, yOf(hi) + 0.8, lw, 3.6, 1, 1, "F");
      w.text(b.label, cx + 2.7, yOf(hi) + 3.4);
    });
    // Pic
    if (a.fMax) {
      const px = xOf(a.fMax.at);
      const py = yOf(a.fMax.v);
      w.fill("#ffffff");
      w.stroke(P.brand);
      doc.setLineWidth(0.5);
      doc.circle(px, py, 1.3, "FD");
      const label = `pic ${a.fMax.v} à ${fmtHm(a.fMax.at)}`;
      w.font(7, "bold", P.ink);
      const lw = doc.getTextWidth(clean(label)) + 4;
      const lx = Math.min(Math.max(px - lw / 2, cx), cx + cw - lw);
      const ly = Math.max(py - 7.5, top - 1);
      w.fill("#ffffff");
      w.stroke(P.line);
      doc.setLineWidth(0.2);
      doc.roundedRect(lx, ly, lw, 4.6, 1.2, 1.2, "FD");
      w.text(label, lx + lw / 2, ly + 3.3, { align: "center" });
    }
    doc.setLineWidth(0.2);
  }

  // Bande des niveaux
  const stripY = top + ch + (hasScore ? 3 : 0);
  const stripH = hasScore ? 5 : 9;
  w.fill(P.soft);
  doc.rect(cx, stripY, cw, stripH, "F");
  a.session.timeline.forEach((p, i) => {
    const next = a.session.timeline[i + 1]?.at ?? t1;
    const x0 = xOf(Math.max(p.at, t0));
    const x1 = xOf(Math.min(next, t1));
    if (x1 - x0 <= 0) return;
    w.fill(LV[p.level]);
    doc.rect(x0, stripY, Math.max(x1 - x0, 0.25), stripH, "F");
  });
  w.font(6.5, "normal", P.faint);
  w.text("niv.", cx - 1.5, stripY + stripH / 2 + 1.1, { align: "right" });
  // Heures
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const at = t0 + ((t1 - t0) * i) / ticks;
    w.font(6.5, "normal", P.muted);
    w.text(a.durationMs < 10 * 60 * 1000 ? fmtTime(at) : fmtHm(at), cx + (cw * i) / ticks, stripY + stripH + 4, {
      align: i === 0 ? "left" : i === ticks ? "right" : "center",
    });
  }
  w.y = stripY + stripH + 8;
  if (!hasScore) {
    w.y += w.para(
      "Score de fatigue non disponible : cette session a été enregistrée avant l'ajout du score.",
      M,
      w.y,
      W,
      8,
      P.muted,
    );
  }
  w.y += 2;
}

function drawSigns(w: Writer, a: Analysis) {
  const { doc } = w;
  w.section(
    4,
    "Signes de fatigue détectés",
    "Nombre de fois où chaque signe a été observé pendant le trajet, avec sa signification.",
  );
  const max = Math.max(1, ...SIGNS.map((x) => a.signs[x.kind]));
  const textW = W * 0.56;
  const barX = M + textW + 6;
  const barW = W - textW - 18;
  SIGNS.forEach((x, i) => {
    const descH = w.paraHeight(x.desc, textW, 7.5);
    const rowH = Math.max(12, descH + 7);
    w.ensure(rowH + 2);
    if (i % 2 === 0) {
      w.fill(P.soft);
      doc.roundedRect(M - 2, w.y - 1, W + 4, rowH, 2, 2, "F");
    }
    w.font(9, "bold", P.ink);
    w.text(x.name, M + 1, w.y + 4);
    w.para(x.desc, M + 1, w.y + 8, textW, 7.5, P.muted);
    const n = a.signs[x.kind];
    const by = w.y + rowH / 2 - 3;
    w.fill(P.line);
    doc.roundedRect(barX, by, barW, 4.5, 1.2, 1.2, "F");
    if (n > 0) {
      w.fill(n >= 3 ? LV[2] : LV[1]);
      doc.roundedRect(barX, by, Math.max((n / max) * barW, 2.4), 4.5, 1.2, 1.2, "F");
    }
    w.font(11, "bold", n ? P.ink : P.faint);
    w.text(String(n), M + W, by + 3.9, { align: "right" });
    w.y += rowH + 1;
  });
  w.y += 3;
}

const KIND_LABEL: Record<EventKind, string> = {
  closure: "Yeux fermés",
  yawn: "Bâillement",
  nod: "Hochement",
  distraction: "Distraction",
  faceLost: "Visage perdu",
  level: "Niveau",
  calibration: "Calibration",
};

function drawMoments(w: Writer, a: Analysis) {
  const { doc } = w;
  const rows = a.session.events.filter(
    (e) => e.kind !== "calibration" && (e.kind !== "level" || (e.level ?? 0) >= 2 || e.message.startsWith("Alerte arrêtée")),
  );
  w.section(
    5,
    "Moments à risque",
    rows.length
      ? "Chronologie des événements importants : signes de fatigue et montées en alerte (niveau 2 ou 3). La colonne « Depuis le départ » situe chaque moment dans le trajet."
      : undefined,
  );
  if (!rows.length) {
    w.ensure(12);
    w.fill(tint(LV[0], 0.1));
    doc.roundedRect(M, w.y, W, 10, 2, 2, "F");
    w.font(9, "bold", LV_TEXT[0]);
    w.text("Aucun moment à risque pendant ce trajet.", M + 4, w.y + 6.3);
    w.y += 15;
    return;
  }
  const MAX_ROWS = 22;
  const shown = rows.slice(0, MAX_ROWS);
  const cols = [
    { title: "Heure", x: M + 2 },
    { title: "Depuis le départ", x: M + 24 },
    { title: "Type", x: M + 54 },
    { title: "Description", x: M + 84 },
  ];
  const header = () => {
    w.fill(P.dark);
    doc.roundedRect(M, w.y, W, 7, 1.5, 1.5, "F");
    w.font(7.5, "bold", "#ffffff");
    cols.forEach((c) => w.text(c.title, c.x, w.y + 4.7));
    w.y += 8;
  };
  w.ensure(16);
  header();
  shown.forEach((e, i) => {
    if (w.y + 7 > BOTTOM) {
      w.ensure(20);
      header();
    }
    if (i % 2 === 1) {
      w.fill(P.soft);
      doc.rect(M, w.y - 0.5, W, 6.6, "F");
    }
    const lvl = e.level ?? (e.kind === "closure" || e.kind === "nod" ? 2 : 1);
    const isStop = e.message.startsWith("Alerte arrêtée");
    w.font(8, "normal", P.ink);
    w.text(fmtTime(e.at), cols[0].x, w.y + 4);
    w.font(8, "normal", P.muted);
    w.text(`+${fmtDur(e.at - a.session.start)}`, cols[1].x, w.y + 4);
    // Pastille
    const tag = e.kind === "level" ? (isStop ? "Réponse" : `Niveau ${e.level}`) : KIND_LABEL[e.kind];
    const tagColor = isStop ? LV[0] : LV[lvl];
    w.font(7, "bold", isStop ? LV_TEXT[0] : LV_TEXT[lvl]);
    const tw = doc.getTextWidth(clean(tag)) + 5;
    w.fill(tint(tagColor, 0.18));
    doc.roundedRect(cols[2].x, w.y + 0.9, tw, 4.4, 2.2, 2.2, "F");
    w.text(tag, cols[2].x + tw / 2, w.y + 4, { align: "center" });
    w.font(8, "normal", P.text);
    const msg = doc.splitTextToSize(clean(e.message), M + W - cols[3].x - 2) as string[];
    doc.text(msg[0] + (msg.length > 1 ? "..." : ""), cols[3].x, w.y + 4);
    w.y += 6.6;
  });
  if (rows.length > MAX_ROWS) {
    w.font(7.5, "normal", P.muted);
    w.text(`... et ${rows.length - MAX_ROWS} autres événements (voir l'export CSV du tableau de bord).`, M, w.y + 4);
    w.y += 6;
  }
  w.y += 4;
}

function drawBox(w: Writer, a: Analysis) {
  const { doc } = w;
  const b = a.boxStats;
  w.section(
    6,
    "Boîtier d'alerte et réactions du conducteur",
    "Le boîtier ESP32 reçoit le niveau d'alerte par MQTT. Au niveau 3, l'alerte reste active jusqu'à ce que le conducteur appuie sur le bouton ; sans réponse pendant 5 s, un SOS WhatsApp part vers ses proches avec sa position.",
  );
  if (!b.connected && !a.stoppedByDriver) {
    w.ensure(12);
    w.fill(P.soft);
    doc.roundedRect(M, w.y, W, 10, 2, 2, "F");
    w.font(9, "normal", P.muted);
    w.text("Le boîtier n'était pas connecté pendant ce trajet : seules les alertes de la plateforme ont été utilisées.", M + 4, w.y + 6.3);
    w.y += 15;
    return;
  }
  const tiles = [
    { label: "Alertes arrêtées", value: String(Math.max(b.acks, a.stoppedByDriver)), sub: "bouton boîtier ou plateforme" },
    {
      label: "Temps de réaction",
      value: b.reactionAvg !== null ? `${(b.reactionAvg / 1000).toFixed(1)} s` : "-",
      sub: "moyenne, alerte -> bouton",
    },
    { label: "SOS WhatsApp", value: String(b.sos), sub: b.sos ? "proches prévenus" : "aucun envoi nécessaire" },
    {
      label: "Latence réseau",
      value: b.latencyAvg !== null ? `${Math.round(b.latencyAvg)} ms` : "-",
      sub: "plateforme <-> boîtier",
    },
  ];
  const gap = 4;
  const tw = (W - gap * 3) / 4;
  w.ensure(26);
  tiles.forEach((t, i) => {
    const x = M + i * (tw + gap);
    w.fill(P.soft);
    doc.roundedRect(x, w.y, tw, 21, 2.5, 2.5, "F");
    w.font(7.5, "normal", P.muted);
    w.text(t.label, x + 4, w.y + 6);
    w.font(14, "bold", t.label === "SOS WhatsApp" && b.sos ? LV_TEXT[3] : P.ink);
    w.text(t.value, x + 4, w.y + 13.5);
    w.font(7, "normal", P.muted);
    w.text(t.sub, x + 4, w.y + 18);
  });
  w.y += 26;
  if (b.pauses) {
    w.y += w.para(`Pauses acceptées pendant le trajet : ${b.pauses}.`, M, w.y, W, 8.5, P.text) + 2;
  }
}

function drawRecommendations(w: Writer, a: Analysis) {
  const { doc } = w;
  w.section(
    7, "Recommandations", "Conseils générés automatiquement à partir des signes observés.");
  recommendations(a).forEach((r, i) => {
    const textH = w.paraHeight(r.text, W - 16, 8.5);
    const h = textH + 10;
    w.ensure(h + 3);
    w.fill(tint(LV[r.level], 0.08));
    doc.roundedRect(M, w.y, W, h, 2.5, 2.5, "F");
    w.fill(LV[r.level]);
    doc.circle(M + 6, w.y + 5.6, 3, "F");
    w.font(8, "bold", r.level === 1 ? P.ink : "#ffffff");
    w.text(String(i + 1), M + 6, w.y + 6.7, { align: "center" });
    w.font(9.5, "bold", P.ink);
    w.text(r.title, M + 12, w.y + 6.6);
    w.para(r.text, M + 12, w.y + 11.3, W - 16, 8.5, P.text);
    w.y += h + 3;
  });
  w.y += 2;
}

function drawGlossary(w: Writer, a: Analysis) {
  const { doc } = w;
  w.section(
    8,
    "Comment lire ce rapport",
    "Définition des indicateurs utilisés. Ce rapport est une aide à la prévention : il ne remplace pas l'avis d'un médecin. En cas de somnolence fréquente au volant, consultez un professionnel de santé.",
  );
  const items: [string, string][] = [
    [
      "Niveaux d'alerte",
      "0 Normal : conducteur éveillé. 1 Vigilance : premiers signes (bâillements, PERCLOS > 15 %). 2 Alerte : yeux fermés plus de 1 s, tête qui tombe, regard détourné. 3 Danger : yeux fermés ou tête tombée plus de 2 s, ou 3 hochements en 1 min.",
    ],
    [
      "Score de fatigue",
      "Somme pondérée : fermeture des yeux en cours (30 pts), PERCLOS (30), bâillements des 5 dernières min (15), hochements et tête basse (15), clignements trop fréquents (10). Le niveau d'alerte impose un minimum (niveau 3 = 85).",
    ],
    [
      "PERCLOS",
      "PERcentage of eyelid CLOSure : part du temps où les yeux sont fermés sur la dernière minute. Indicateur de référence de la somnolence ; au-delà de 15 % la fatigue est installée.",
    ],
    [
      "EAR et MAR",
      "Eye / Mouth Aspect Ratio : rapport hauteur / largeur de l'œil et de la bouche, calculé sur 478 points du visage. Un EAR bas = œil fermé ; un MAR haut = bouche grande ouverte.",
    ],
    [
      "Calibration",
      a.calibration
        ? `Au démarrage, 5 s de visage neutre fixent les valeurs normales du conducteur. Ce trajet : ${a.calibration.replace(/^Calibration /, "")}.`
        : "Au démarrage, 5 s de visage neutre fixent les valeurs normales du conducteur (EAR, position de la tête).",
    ],
    [
      "Version utilisée",
      a.session.variant === "v2"
        ? "V2 : un modèle MobileNetV2 entraîné sur nos propres images classe les yeux (ouverts / fermés) et la bouche (bâillement ou non)."
        : "V1 : MediaPipe Face Landmarker de Google ; la décision repose sur l'EAR, le MAR et la pose de la tête.",
    ],
  ];
  const colW = (W - 6) / 2;
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2);
    const h = Math.max(...pair.map(([, d]) => w.paraHeight(d, colW - 8, 7.8))) + 12;
    w.ensure(h + 3);
    pair.forEach(([t, d], k) => {
      const x = M + k * (colW + 6);
      w.stroke(P.line);
      doc.setLineWidth(0.25);
      doc.roundedRect(x, w.y, colW, h, 2.5, 2.5, "S");
      w.font(9, "bold", P.brand);
      w.text(t, x + 4, w.y + 6.5);
      w.para(d, x + 4, w.y + 11.3, colW - 8, 7.8, P.text);
    });
    w.y += h + 4;
  }
}

/** Construit le PDF du trajet (sans le télécharger). */
export async function buildSessionReport(session: SessionLog, logs: Logs) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const a = analyseSession(session, logs);
  const d = new Date(session.start);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateShort = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  doc.setProperties({
    title: `Rapport de trajet DriveAlert AI - ${dateShort}`,
    subject: "Détection de somnolence au volant",
    creator: "DriveAlert AI",
  });
  const w = new Writer(doc, `DriveAlert AI · Rapport de trajet du ${dateShort} à ${fmtHm(session.start)}`);
  drawCover(w, a);
  drawVerdict(w, a);
  drawKpis(w, a);
  drawLevelSplit(w, a);
  drawTripSheet(w, a);
  drawFatigueChart(w, a);
  drawSigns(w, a);
  drawMoments(w, a);
  drawBox(w, a);
  drawRecommendations(w, a);
  drawGlossary(w, a);
  w.footer(`${new Date().toLocaleDateString("fr-FR")} à ${fmtHm(Date.now())}`);
  const filename = `rapport-trajet-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}h${pad(d.getMinutes())}.pdf`;
  return { doc, filename };
}

/** Génère et télécharge le PDF du trajet. */
export async function downloadSessionReport(session: SessionLog, logs: Logs) {
  const { doc, filename } = await buildSessionReport(session, logs);
  doc.save(filename);
}

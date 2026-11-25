// Moteur de décision : transforme les mesures image par image en niveau d'alerte 0–3.
// Aucun réseau ici : tout tourne dans le navigateur.

import { angleDelta, median, type HeadPose } from "./metrics";

export type Level = 0 | 1 | 2 | 3;

export const LEVELS: { name: string; hint: string }[] = [
  { name: "Normal", hint: "Conducteur éveillé" },
  { name: "Vigilance", hint: "Premiers signes de fatigue" },
  { name: "Alerte", hint: "Somnolence probable" },
  { name: "Danger", hint: "Endormissement : arrêtez-vous" },
];

export type EyeSource = "ear" | "blendshape" | "model";
export type MouthSource = "mar" | "model";

export type Settings = {
  eyeSource: EyeSource;
  mouthSource: MouthSource;
  modelEyeThreshold: number; // V2 : probabilité « yeux fermés » au-delà de laquelle on décide fermé
  modelYawnThreshold: number; // V2 : probabilité « bâillement »
  earRatio: number; // seuil EAR = EAR calibré × ratio
  earDefault: number; // seuil EAR tant qu'il n'y a pas de calibration
  blinkScoreThreshold: number; // seuil du score eyeBlink (0–1) de Google
  marThreshold: number; // bouche considérée « grande ouverte »
  yawnMinS: number; // durée minimale d'un bâillement
  blinkMaxS: number; // au-delà, ce n'est plus un clignement
  closedAlertS: number; // fermeture → niveau 2
  closedDangerS: number; // fermeture → niveau 3
  pitchDeg: number; // écart de tête (haut/bas) pour un hochement
  nodMinS: number; // durée minimale du hochement
  headDangerS: number; // tête tombée → niveau 3
  yawDeg: number; // tête tournée (distraction)
  distractionS: number;
  perclosWarn: number; // PERCLOS → niveau 1
  perclosAlert: number; // PERCLOS → niveau 2
  faceLostS: number; // visage perdu → niveau 2
  holdS: number; // maintien d'un niveau après disparition de la cause
};

export const DEFAULT_SETTINGS: Settings = {
  eyeSource: "ear",
  mouthSource: "mar",
  modelEyeThreshold: 0.5,
  modelYawnThreshold: 0.5,
  earRatio: 0.75,
  earDefault: 0.21,
  blinkScoreThreshold: 0.5,
  marThreshold: 0.55,
  yawnMinS: 1.5,
  blinkMaxS: 0.5,
  closedAlertS: 1.0,
  closedDangerS: 2.0,
  pitchDeg: 18,
  nodMinS: 0.8,
  headDangerS: 2.0,
  yawDeg: 30,
  distractionS: 2.0,
  perclosWarn: 0.15,
  perclosAlert: 0.3,
  faceLostS: 2.0,
  holdS: 0.5, // court : le niveau suit le conducteur presque en temps réel
};

export type FaceMeasures = {
  ear: number;
  blinkScore: number; // moyenne eyeBlinkLeft / eyeBlinkRight
  mar: number;
  jawOpen: number;
  pose: HeadPose | null;
  eyeProb?: number; // V2 : probabilité yeux fermés (mon modèle)
  yawnProb?: number; // V2 : probabilité bâillement (mon modèle)
};

export type Baseline = { ear: number; mar: number; pitch: number; yaw: number; roll: number };

export type EventKind = "closure" | "yawn" | "nod" | "distraction" | "faceLost" | "level" | "calibration";

export type EngineEvent = { id: number; t: number; kind: EventKind; message: string; level?: Level };

export type Snapshot = {
  level: Level;
  reasons: string[];
  /** Niveau 3 maintenu jusqu'à l'appui sur le bouton (boîtier ou plateforme). */
  latched: boolean;
  faceVisible: boolean;
  calibrating: boolean;
  calibrationProgress: number;
  baseline: Baseline | null;
  ear: number;
  earThreshold: number;
  blinkScore: number;
  eyesClosed: boolean;
  closedFor: number;
  mar: number;
  jawOpen: number;
  eyeProb: number;
  yawnProb: number;
  yawning: boolean;
  perclos: number;
  blinksPerMin: number;
  yawnsRecent: number;
  nodsRecent: number;
  pitchDelta: number;
  yawDelta: number;
  rollDelta: number;
  faceLostFor: number;
};

const PERCLOS_WINDOW_S = 60;
const YAWN_WINDOW_S = 300;
const NOD_WINDOW_S = 60;
const CALIBRATION_S = 5;

export class DrowsinessEngine {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private baseline: Baseline | null = null;

  private lastT: number | null = null;
  private closedSince: number | null = null;
  private closureReported = false;
  private yawnSince: number | null = null;
  private yawnReported = false;
  private headDownSince: number | null = null;
  private nodReported = false;
  private turnedSince: number | null = null;
  private distractionReported = false;
  private lostSince: number | null = null;
  private lostReported = false;

  private perclosSamples: { t: number; dt: number; closed: boolean }[] = [];
  private blinkTimes: number[] = [];
  private yawnTimes: number[] = [];
  private nodTimes: number[] = [];
  private levelSeenAt: number[] = [-Infinity, -Infinity, -Infinity, -Infinity];
  private level: Level = 0;
  // Danger maintenu : le niveau 3 reste actif jusqu'à ce que le conducteur réponde.
  private latched = false;
  private latchReason = "";
  private ackFrom: string | null = null;

  private calibration: { start: number; samples: Baseline[] } | null = null;
  private nextEventId = 1;

  getBaseline() {
    return this.baseline;
  }

  startCalibration(t: number) {
    this.calibration = { start: t, samples: [] };
  }

  /** Le conducteur a répondu (bouton du boîtier ou de la plateforme) : fin de l'alerte en cours. */
  acknowledge(from: string) {
    if (!this.latched && this.level < 3) return;
    this.latched = false;
    this.ackFrom = from;
    // On repart de zéro pour ne pas relancer aussitôt la même alerte.
    this.levelSeenAt = [-Infinity, -Infinity, -Infinity, -Infinity];
    this.closedSince = null;
    this.closureReported = false;
    this.headDownSince = null;
    this.nodTimes = [];
  }

  isLatched() {
    return this.latched;
  }

  reset() {
    const settings = this.settings;
    const baseline = this.baseline;
    Object.assign(this, new DrowsinessEngine());
    this.settings = settings;
    this.baseline = baseline;
  }

  private earThreshold() {
    return this.baseline ? this.baseline.ear * this.settings.earRatio : this.settings.earDefault;
  }

  private event(t: number, kind: EventKind, message: string, level?: Level): EngineEvent {
    return { id: this.nextEventId++, t, kind, message, level };
  }

  /** t en secondes. face = null quand aucun visage n'est détecté. */
  update(t: number, face: FaceMeasures | null): { snapshot: Snapshot; events: EngineEvent[] } {
    const s = this.settings;
    const events: EngineEvent[] = [];
    const dt = this.lastT === null ? 0 : Math.min(t - this.lastT, 0.25);
    this.lastT = t;

    // ---- Calibration -------------------------------------------------------
    let calibrationProgress = 0;
    if (this.calibration) {
      const elapsed = t - this.calibration.start;
      calibrationProgress = Math.min(elapsed / CALIBRATION_S, 1);
      if (face?.pose) {
        this.calibration.samples.push({
          ear: face.ear,
          mar: face.mar,
          pitch: face.pose.pitch,
          yaw: face.pose.yaw,
          roll: face.pose.roll,
        });
      }
      if (elapsed >= CALIBRATION_S) {
        const smp = this.calibration.samples;
        this.calibration = null;
        if (smp.length >= 20) {
          this.baseline = {
            ear: median(smp.map((x) => x.ear)),
            mar: median(smp.map((x) => x.mar)),
            pitch: median(smp.map((x) => x.pitch)),
            yaw: median(smp.map((x) => x.yaw)),
            roll: median(smp.map((x) => x.roll)),
          };
          events.push(
            this.event(
              t,
              "calibration",
              `Calibration réussie : EAR normal ${this.baseline.ear.toFixed(3)}, seuil ${this.earThreshold().toFixed(3)}`,
            ),
          );
        } else {
          events.push(this.event(t, "calibration", "Calibration échouée : visage pas assez visible, recommencez"));
        }
      }
    }
    const calibrating = this.calibration !== null;

    // ---- Visage perdu ------------------------------------------------------
    let faceLostFor = 0;
    if (!face) {
      this.lostSince ??= t;
      faceLostFor = t - this.lostSince;
      if (faceLostFor >= s.faceLostS && !this.lostReported) {
        this.lostReported = true;
        events.push(this.event(t, "faceLost", "Visage non détecté (tête tombée ou hors champ ?)"));
      }
      // On ne sait plus rien des yeux : on remet à zéro les épisodes en cours.
      this.closedSince = null;
      this.yawnSince = null;
      this.headDownSince = null;
      this.turnedSince = null;
    } else {
      this.lostSince = null;
      this.lostReported = false;
    }

    // ---- Yeux --------------------------------------------------------------
    const earThreshold = this.earThreshold();
    const eyesClosed = face
      ? s.eyeSource === "model" && face.eyeProb !== undefined
        ? face.eyeProb > s.modelEyeThreshold
        : s.eyeSource === "blendshape"
          ? face.blinkScore > s.blinkScoreThreshold
          : face.ear < earThreshold
      : false;

    let closedFor = 0;
    if (face && !calibrating) {
      if (eyesClosed) {
        this.closedSince ??= t;
        closedFor = t - this.closedSince;
        if (closedFor >= s.closedAlertS && !this.closureReported) {
          this.closureReported = true;
          events.push(this.event(t, "closure", `Yeux fermés depuis plus de ${s.closedAlertS.toFixed(1)} s`));
        }
      } else if (this.closedSince !== null) {
        const duration = t - this.closedSince;
        if (duration <= s.blinkMaxS) this.blinkTimes.push(t);
        this.closedSince = null;
        this.closureReported = false;
      }
      this.perclosSamples.push({ t, dt, closed: eyesClosed });
    }

    // ---- Bouche (bâillement) -----------------------------------------------
    let yawning = false;
    if (face && !calibrating) {
      const mouthOpen =
        s.mouthSource === "model" && face.yawnProb !== undefined
          ? face.yawnProb > s.modelYawnThreshold
          : face.mar > s.marThreshold;
      if (mouthOpen) {
        this.yawnSince ??= t;
        if (t - this.yawnSince >= s.yawnMinS) {
          yawning = true;
          if (!this.yawnReported) {
            this.yawnReported = true;
            this.yawnTimes.push(t);
            events.push(this.event(t, "yawn", "Bâillement détecté"));
          }
        }
      } else {
        this.yawnSince = null;
        this.yawnReported = false;
      }
    }

    // ---- Tête ---------------------------------------------------------------
    let pitchDelta = 0;
    let yawDelta = 0;
    let rollDelta = 0;
    let headDownFor = 0;
    let turnedFor = 0;
    if (face?.pose && !calibrating) {
      const b = this.baseline ?? { pitch: 0, yaw: 0, roll: 0 };
      pitchDelta = angleDelta(face.pose.pitch, b.pitch);
      yawDelta = angleDelta(face.pose.yaw, b.yaw);
      rollDelta = angleDelta(face.pose.roll, b.roll);

      // Tête qui tombe : pitch ou roll (tête qui bascule sur l'épaule).
      const dropped = Math.abs(pitchDelta) > s.pitchDeg || Math.abs(rollDelta) > s.pitchDeg + 10;
      if (dropped) {
        this.headDownSince ??= t;
        headDownFor = t - this.headDownSince;
        if (headDownFor >= s.nodMinS && !this.nodReported) {
          this.nodReported = true;
          this.nodTimes.push(t);
          events.push(this.event(t, "nod", `Tête qui tombe (${Math.abs(pitchDelta).toFixed(0)}°)`));
        }
      } else {
        this.headDownSince = null;
        this.nodReported = false;
      }

      if (Math.abs(yawDelta) > s.yawDeg) {
        this.turnedSince ??= t;
        turnedFor = t - this.turnedSince;
        if (turnedFor >= s.distractionS && !this.distractionReported) {
          this.distractionReported = true;
          events.push(this.event(t, "distraction", "Regard détourné de la route"));
        }
      } else {
        this.turnedSince = null;
        this.distractionReported = false;
      }
    }

    // ---- Fenêtres glissantes ----------------------------------------------
    this.perclosSamples = this.perclosSamples.filter((x) => t - x.t <= PERCLOS_WINDOW_S);
    this.blinkTimes = this.blinkTimes.filter((x) => t - x <= 60);
    this.yawnTimes = this.yawnTimes.filter((x) => t - x <= YAWN_WINDOW_S);
    this.nodTimes = this.nodTimes.filter((x) => t - x <= NOD_WINDOW_S);

    const totalTime = this.perclosSamples.reduce((a, x) => a + x.dt, 0);
    const closedTime = this.perclosSamples.reduce((a, x) => a + (x.closed ? x.dt : 0), 0);
    // PERCLOS fiable seulement après ~10 s d'observation.
    const perclos = totalTime >= 10 ? closedTime / totalTime : 0;
    const observedMin = Math.max(totalTime, 1) / 60;
    const blinksPerMin = this.blinkTimes.length / Math.min(observedMin, 1);

    // ---- Niveau brut ------------------------------------------------------
    const reasons: string[] = [];
    let raw: Level = 0;
    const raise = (lvl: Level, reason: string) => {
      if (lvl > raw) raw = lvl;
      reasons.push(reason);
    };

    if (!calibrating) {
      if (closedFor >= s.closedDangerS) raise(3, `Yeux fermés ${closedFor.toFixed(1)} s`);
      else if (closedFor >= s.closedAlertS) raise(2, `Yeux fermés ${closedFor.toFixed(1)} s`);

      if (headDownFor >= s.headDangerS) raise(3, `Tête tombée ${headDownFor.toFixed(1)} s`);
      else if (headDownFor >= s.nodMinS) raise(2, "Tête qui tombe");

      if (this.nodTimes.length >= 3) raise(3, `${this.nodTimes.length} hochements en 1 min`);
      else if (this.nodTimes.length === 2) raise(2, "2 hochements en 1 min");
      else if (this.nodTimes.length === 1) raise(1, "1 hochement récent");

      if (perclos >= s.perclosAlert) raise(2, `PERCLOS ${(perclos * 100).toFixed(0)} %`);
      else if (perclos >= s.perclosWarn) raise(1, `PERCLOS ${(perclos * 100).toFixed(0)} %`);

      if (turnedFor >= s.distractionS) raise(2, "Regard détourné");
      if (faceLostFor >= s.faceLostS) raise(2, "Visage non détecté");

      if (yawning) raise(1, "Bâillement en cours");
      if (this.yawnTimes.length >= 2) raise(1, `${this.yawnTimes.length} bâillements en 5 min`);
    }

    // ---- Maintien (évite le clignotement des alertes) ---------------------
    for (let l = 1; l <= raw; l++) this.levelSeenAt[l] = t;
    let level: Level = 0;
    for (let l = 3; l >= 1; l--) {
      if (t - this.levelSeenAt[l] <= s.holdS) {
        level = l as Level;
        break;
      }
    }

    // ---- Danger maintenu jusqu'à la réponse du conducteur -------------------
    if (this.ackFrom !== null) {
      events.push(this.event(t, "level", `Alerte arrêtée par le conducteur (${this.ackFrom})`, 0));
      this.ackFrom = null;
    }
    if (level === 3 && !this.latched) {
      this.latched = true;
      this.latchReason = reasons.join(" · ");
    }
    if (this.latched) {
      level = 3;
      if (!reasons.length) reasons.push(`${this.latchReason} · en attente du bouton`);
    }

    if (level !== this.level) {
      if (level > this.level) {
        events.push(this.event(t, "level", `Niveau ${level} · ${LEVELS[level].name} — ${reasons.join(", ")}`, level));
      } else if (level === 0) {
        events.push(this.event(t, "level", "Retour à la normale", 0));
      }
      this.level = level;
    }

    return {
      events,
      snapshot: {
        level,
        reasons,
        latched: this.latched,
        faceVisible: face !== null,
        calibrating,
        calibrationProgress,
        baseline: this.baseline,
        ear: face?.ear ?? 0,
        earThreshold,
        blinkScore: face?.blinkScore ?? 0,
        eyesClosed,
        closedFor,
        mar: face?.mar ?? 0,
        jawOpen: face?.jawOpen ?? 0,
        eyeProb: face?.eyeProb ?? 0,
        yawnProb: face?.yawnProb ?? 0,
        yawning,
        perclos,
        blinksPerMin,
        yawnsRecent: this.yawnTimes.length,
        nodsRecent: this.nodTimes.length,
        pitchDelta,
        yawDelta,
        rollDelta,
        faceLostFor,
      },
    };
  }
}

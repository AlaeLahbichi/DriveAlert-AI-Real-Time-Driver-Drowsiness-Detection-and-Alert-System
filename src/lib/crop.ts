// Découpe des yeux et de la bouche à partir des points de Face Landmarker.
// Chaque découpe est carrée, redressée (la ligne des yeux devient horizontale)
// et redimensionnée à OUT_SIZE × OUT_SIZE pixels.

import { LEFT_EYE, MOUTH, RIGHT_EYE, type Point } from "./metrics";
import type { Part } from "./datasetClasses";

export const OUT_SIZE = 96;

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export type Region = { center: Point; size: number; angle: number };

/** Zone carrée à découper pour une partie du visage (coordonnées en pixels de la vidéo). */
export function regionFor(part: Part, pts: Point[]): Region {
  // Angle de la tête dans l'image : ligne entre les coins extérieurs des yeux.
  const angle = Math.atan2(pts[263].y - pts[33].y, pts[263].x - pts[33].x);

  if (part === "bouche") {
    const left = pts[MOUTH.left];
    const right = pts[MOUTH.right];
    const width = dist(left, right);
    const height = dist(pts[0], pts[17]); // haut de la lèvre supérieure → bas de la lèvre inférieure
    return {
      center: mid(mid(left, right), mid(pts[0], pts[17])),
      size: Math.max(width, height) * 1.5,
      angle,
    };
  }
  const idx = part === "oeil_d" ? RIGHT_EYE : LEFT_EYE;
  const p1 = pts[idx[0]];
  const p4 = pts[idx[3]];
  return { center: mid(p1, p4), size: dist(p1, p4) * 1.8, angle };
}

/** true si la zone sort de l'image (on ne garde pas les découpes coupées). */
export function isOutside(r: Region, w: number, h: number): boolean {
  const half = (r.size / 2) * Math.SQRT2; // marge pour la rotation
  return r.center.x - half < 0 || r.center.y - half < 0 || r.center.x + half > w || r.center.y + half > h;
}

/** Dessine une zone de la vidéo, redressée, dans un contexte carré de côté `out`. */
export function drawRegion(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, r: Region, out: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, out, out);
  ctx.imageSmoothingQuality = "high";
  ctx.translate(out / 2, out / 2);
  ctx.rotate(-r.angle);
  const k = out / r.size;
  ctx.scale(k, k);
  ctx.drawImage(video, -r.center.x, -r.center.y);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

let scratch: HTMLCanvasElement | null = null;

/** Découpe une zone de la vidéo et renvoie une image PNG en base64 (data URL). */
export function cropToDataUrl(video: HTMLVideoElement, r: Region): string {
  scratch ??= document.createElement("canvas");
  scratch.width = OUT_SIZE;
  scratch.height = OUT_SIZE;
  drawRegion(scratch.getContext("2d")!, video, r, OUT_SIZE);
  return scratch.toDataURL("image/png");
}

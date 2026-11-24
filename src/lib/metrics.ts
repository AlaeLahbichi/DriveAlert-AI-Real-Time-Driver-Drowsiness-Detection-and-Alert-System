// Calculs géométriques à partir des 478 points de MediaPipe Face Landmarker.

export type Point = { x: number; y: number };

// 6 points de chaque œil, dans l'ordre p1..p6 de la formule EAR.
// p1/p4 = coins de l'œil, p2/p3 = paupière haute, p6/p5 = paupière basse.
export const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
export const LEFT_EYE = [362, 385, 387, 263, 373, 380];

// Bouche : coins (61, 291) et trois paires haut/bas.
export const MOUTH = { left: 61, right: 291, pairs: [[81, 178], [13, 14], [311, 402]] as const };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** EAR = (|p2-p6| + |p3-p5|) / (2 |p1-p4|). Points en pixels pour respecter le rapport largeur/hauteur. */
export function eyeAspectRatio(pts: Point[], idx: number[]): number {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => pts[i]);
  const horizontal = dist(p1, p4);
  if (horizontal === 0) return 0;
  return (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal);
}

/** MAR = moyenne des 3 ouvertures verticales / largeur de la bouche. */
export function mouthAspectRatio(pts: Point[]): number {
  const width = dist(pts[MOUTH.left], pts[MOUTH.right]);
  if (width === 0) return 0;
  const vertical = MOUTH.pairs.reduce((s, [a, b]) => s + dist(pts[a], pts[b]), 0) / MOUTH.pairs.length;
  return vertical / width;
}

export type HeadPose = { pitch: number; yaw: number; roll: number };

/**
 * Angles de la tête (en degrés) à partir de la matrice 4x4 renvoyée par Face Landmarker.
 * Seule la différence avec la position calibrée est utilisée ensuite, donc le sens
 * exact des angles n'a pas d'importance.
 */
export function headPoseFromMatrix(data: number[]): HeadPose {
  // Rotation 3x3 (matrice stockée colonne par colonne).
  const r = (row: number, col: number) => data[col * 4 + row];
  const toDeg = 180 / Math.PI;
  const pitch = Math.atan2(r(2, 1), r(2, 2)) * toDeg;
  const yaw = Math.atan2(-r(2, 0), Math.hypot(r(2, 1), r(2, 2))) * toDeg;
  const roll = Math.atan2(r(1, 0), r(0, 0)) * toDeg;
  return { pitch, yaw, roll };
}

/** Plus petite différence entre deux angles, en degrés (gère le passage -180/180). */
export function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

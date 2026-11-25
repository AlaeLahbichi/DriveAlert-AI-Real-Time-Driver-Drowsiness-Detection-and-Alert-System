// Code couleur de la plateforme, pour les canvas et les SVG (mêmes valeurs que src/app/globals.css).
import type { Level } from "./engine";

export const C = {
  base: "#0b0f17",
  surface: "#121826",
  raised: "#1a2132",
  line: "#262f44",
  ink: "#eef1f7",
  soft: "#c3c9d8",
  muted: "#8e97ad",
  faint: "#626b82",
  brand: "#2a78d6",
  eye: "#3987e5",
  mouth: "#d55181",
  ok: "#0ca30c",
  warn: "#fab219",
  alert: "#ec835a",
  danger: "#d03b3b",
} as const;

/** Couleur de chaque niveau d'alerte (0 Normal → 3 Danger). */
export const LEVEL_COLORS: Record<Level, string> = { 0: C.ok, 1: C.warn, 2: C.alert, 3: C.danger };

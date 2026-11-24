// Classes de la base de données, partagées entre l'interface et le serveur.

export const CLASS_KEYS = ["yeux_ouverts", "yeux_fermes", "bouche_fermee", "bouche_baillement"] as const;
export type ClassKey = (typeof CLASS_KEYS)[number];

export const CLASSES: Record<
  ClassKey,
  { dir: string; label: string; task: "yeux" | "bouche"; key: string; color: string }
> = {
  yeux_ouverts: { dir: "yeux/ouverts", label: "Yeux ouverts", task: "yeux", key: "O", color: "#2A9D8F" },
  yeux_fermes: { dir: "yeux/fermes", label: "Yeux fermés", task: "yeux", key: "F", color: "#E76F51" },
  bouche_fermee: { dir: "bouche/fermee", label: "Bouche normale", task: "bouche", key: "N", color: "#7B5EA7" },
  bouche_baillement: { dir: "bouche/baillement", label: "Bâillement", task: "bouche", key: "B", color: "#F2A541" },
};

export const PARTS = ["oeil_d", "oeil_g", "bouche"] as const;
export type Part = (typeof PARTS)[number];

/** Nombre d'images visé par classe (voir la présentation : 500 à 1000 = bon niveau). */
export const TARGET_PER_CLASS = 500;

/** Identifiant sûr pour un nom de fichier : minuscules, chiffres, - et _. */
export function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export type CaptureMeta = {
  ear: number;
  blinkScore: number;
  mar: number;
  jawOpen: number;
  pitch: number;
  yaw: number;
  roll: number;
};

export type CaptureItem = { cls: ClassKey; part: Part; image: string; meta: CaptureMeta };

export type SaveRequest = {
  person: string;
  session: string;
  source: "manuel" | "auto";
  burst: string;
  glasses: boolean;
  lighting: "jour" | "faible" | "nuit";
  captures: CaptureItem[];
};

export type SavedFile = { file: string; cls: ClassKey };

export type DatasetStats = {
  dataDir: string;
  total: number;
  classes: Record<ClassKey, number>;
  persons: Record<string, Record<ClassKey, number>>;
  split: null | { createdAt: string; sets: Record<"train" | "val" | "test", { persons: string[]; images: number }>; mode: string };
};

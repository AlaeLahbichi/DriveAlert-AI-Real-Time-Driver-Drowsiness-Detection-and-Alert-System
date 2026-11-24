// Côté serveur uniquement : écriture des images et des étiquettes dans le dossier data/.
//
// data/
//   yeux/ouverts/*.png      yeux/fermes/*.png
//   bouche/fermee/*.png     bouche/baillement/*.png
//   labels.csv              une ligne par image (personne, session, mesures MediaPipe…)
//   split.csv               découpage entraînement / validation / test par personne

import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CLASSES,
  CLASS_KEYS,
  PARTS,
  slug,
  type ClassKey,
  type DatasetStats,
  type SaveRequest,
  type SavedFile,
} from "./datasetClasses";

export const DATA_DIR = path.join(process.cwd(), "data");
const LABELS_CSV = path.join(DATA_DIR, "labels.csv");
const SPLIT_CSV = path.join(DATA_DIR, "split.csv");
const SPLIT_JSON = path.join(DATA_DIR, "split.json");

const CSV_HEADER =
  "file,class,task,part,person,session,source,burst,glasses,lighting,ear,blink_score,mar,jaw_open,pitch,yaw,roll,created_at\n";

// Nom : <personne>__<session>__<horodatage>-<n>_<partie>.png
const FILE_RE = /^([a-z0-9_-]+)__([a-z0-9_-]+)__(\d+-\d+)_(oeil_d|oeil_g|bouche)\.png$/;

async function ensureDirs() {
  for (const k of CLASS_KEYS) await fs.mkdir(path.join(DATA_DIR, CLASSES[k].dir), { recursive: true });
  try {
    await fs.access(LABELS_CSV);
  } catch {
    await fs.writeFile(LABELS_CSV, CSV_HEADER);
  }
}

let counter = 0;

export async function saveCaptures(req: SaveRequest): Promise<SavedFile[]> {
  const person = slug(req.person);
  const session = slug(req.session);
  if (!person) throw new Error("Nom de la personne manquant");
  if (!session) throw new Error("Nom de session manquant");
  if (!Array.isArray(req.captures) || req.captures.length === 0 || req.captures.length > 12) {
    throw new Error("Nombre de captures invalide");
  }
  const lighting = ["jour", "faible", "nuit"].includes(req.lighting) ? req.lighting : "jour";
  const source = req.source === "auto" ? "auto" : "manuel";
  const burst = slug(String(req.burst ?? ""));

  await ensureDirs();
  const stamp = `${Date.now()}-${(counter = (counter + 1) % 100000)}`;
  const saved: SavedFile[] = [];
  let csv = "";

  for (const c of req.captures) {
    if (!CLASS_KEYS.includes(c.cls)) throw new Error(`Classe inconnue : ${c.cls}`);
    if (!PARTS.includes(c.part)) throw new Error(`Partie inconnue : ${c.part}`);
    if (CLASSES[c.cls].task === "yeux" && c.part === "bouche") throw new Error("Classe yeux avec une image de bouche");
    if (CLASSES[c.cls].task === "bouche" && c.part !== "bouche") throw new Error("Classe bouche avec une image d'œil");
    const prefix = "data:image/png;base64,";
    if (typeof c.image !== "string" || !c.image.startsWith(prefix) || c.image.length > 400_000) {
      throw new Error("Image invalide");
    }
    const name = `${person}__${session}__${stamp}_${c.part}.png`;
    const rel = `${CLASSES[c.cls].dir}/${name}`;
    await fs.writeFile(path.join(DATA_DIR, rel), Buffer.from(c.image.slice(prefix.length), "base64"));
    saved.push({ file: rel, cls: c.cls });

    const m = c.meta ?? {};
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "");
    csv +=
      [
        rel,
        c.cls,
        CLASSES[c.cls].task,
        c.part,
        person,
        session,
        source,
        burst,
        req.glasses ? 1 : 0,
        lighting,
        n(m.ear),
        n(m.blinkScore),
        n(m.mar),
        n(m.jawOpen),
        n(m.pitch),
        n(m.yaw),
        n(m.roll),
        new Date().toISOString(),
      ].join(",") + "\n";
  }
  await fs.appendFile(LABELS_CSV, csv);
  return saved;
}

/** Chemin relatif sûr (pas de « .. », bonne classe, bon format de nom). */
function safeRel(rel: string): string | null {
  const parts = rel.split("/");
  const name = parts.pop() ?? "";
  const dir = parts.join("/");
  if (!CLASS_KEYS.some((k) => CLASSES[k].dir === dir) || !FILE_RE.test(name)) return null;
  return `${dir}/${name}`;
}

export async function deleteFiles(files: string[]): Promise<number> {
  const rels = new Set(files.map(safeRel).filter((x): x is string => x !== null));
  let removed = 0;
  for (const rel of rels) {
    try {
      await fs.unlink(path.join(DATA_DIR, rel));
      removed++;
    } catch {
      /* déjà supprimé */
    }
  }
  try {
    const lines = (await fs.readFile(LABELS_CSV, "utf8")).split("\n");
    const kept = lines.filter((l, i) => i === 0 || (l && !rels.has(l.split(",")[0])));
    await fs.writeFile(LABELS_CSV, kept.join("\n") + "\n");
  } catch {
    /* pas encore de CSV */
  }
  return removed;
}

/** Liste toutes les images présentes dans data/ (le disque fait foi, même après une suppression à la main). */
async function scan(): Promise<{ rel: string; cls: ClassKey; person: string }[]> {
  const out: { rel: string; cls: ClassKey; person: string }[] = [];
  for (const k of CLASS_KEYS) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(DATA_DIR, CLASSES[k].dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (m) out.push({ rel: `${CLASSES[k].dir}/${name}`, cls: k, person: m[1] });
    }
  }
  return out;
}

const emptyCounts = () => Object.fromEntries(CLASS_KEYS.map((k) => [k, 0])) as Record<ClassKey, number>;

export async function getStats(): Promise<DatasetStats> {
  const files = await scan();
  const classes = emptyCounts();
  const persons: DatasetStats["persons"] = {};
  for (const f of files) {
    classes[f.cls]++;
    (persons[f.person] ??= emptyCounts())[f.cls]++;
  }
  let split: DatasetStats["split"] = null;
  try {
    split = JSON.parse(await fs.readFile(SPLIT_JSON, "utf8"));
  } catch {
    /* pas encore de découpage */
  }
  return { dataDir: DATA_DIR, total: files.length, classes, persons, split };
}

type SetName = "train" | "val" | "test";
const RATIOS: Record<SetName, number> = { train: 0.7, val: 0.15, test: 0.15 };

/**
 * Découpage 70 / 15 / 15 PAR PERSONNE : une même personne n'apparaît que dans un seul ensemble,
 * sinon le test serait trop facile (le modèle aurait déjà vu ce visage).
 */
export async function createSplit(): Promise<NonNullable<DatasetStats["split"]>> {
  const files = await scan();
  if (files.length === 0) throw new Error("La base est vide");
  const byPerson = new Map<string, number>();
  for (const f of files) byPerson.set(f.person, (byPerson.get(f.person) ?? 0) + 1);
  const persons = [...byPerson.entries()].sort((a, b) => b[1] - a[1]);

  const assign = new Map<string, SetName>();
  let mode: string;
  if (persons.length >= 3) {
    mode = "par personne";
    const count: Record<SetName, number> = { train: 0, val: 0, test: 0 };
    // Une personne au minimum en validation et en test, puis on remplit l'ensemble le plus en retard.
    const order = [...persons].reverse(); // les plus petites d'abord pour val/test
    assign.set(order[0][0], "test");
    count.test += order[0][1];
    assign.set(order[1][0], "val");
    count.val += order[1][1];
    for (const [p, n] of persons) {
      if (assign.has(p)) continue;
      const total = count.train + count.val + count.test + n;
      const lag = (s: SetName) => RATIOS[s] * total - count[s];
      const best = (["train", "val", "test"] as SetName[]).sort((a, b) => lag(b) - lag(a))[0];
      assign.set(p, best);
      count[best] += n;
    }
  } else {
    mode = "par image (moins de 3 personnes : à refaire quand vous aurez plus de volontaires)";
  }

  // Découpage par image (secours) : déterministe à partir du nom de fichier.
  const hashSet = (rel: string): SetName => {
    let h = 0;
    for (let i = 0; i < rel.length; i++) h = (h * 31 + rel.charCodeAt(i)) >>> 0;
    const r = (h % 1000) / 1000;
    return r < 0.7 ? "train" : r < 0.85 ? "val" : "test";
  };

  const sets: NonNullable<DatasetStats["split"]>["sets"] = {
    train: { persons: [], images: 0 },
    val: { persons: [], images: 0 },
    test: { persons: [], images: 0 },
  };
  let csv = "file,class,person,set\n";
  for (const f of files) {
    const s = assign.get(f.person) ?? hashSet(f.rel);
    sets[s].images++;
    if (!sets[s].persons.includes(f.person)) sets[s].persons.push(f.person);
    csv += `${f.rel},${f.cls},${f.person},${s}\n`;
  }
  const result = { createdAt: new Date().toISOString(), sets, mode };
  await fs.writeFile(SPLIT_CSV, csv);
  await fs.writeFile(SPLIT_JSON, JSON.stringify(result, null, 2));
  return result;
}

export async function readImage(rel: string): Promise<Buffer | null> {
  const safe = safeRel(rel);
  if (!safe) return null;
  try {
    return await fs.readFile(path.join(DATA_DIR, safe));
  } catch {
    return null;
  }
}

/** Images d'une classe, les plus récentes d'abord (pour la vérification visuelle). */
export async function listClass(cls: ClassKey, offset: number, limit: number) {
  const dir = path.join(DATA_DIR, CLASSES[cls].dir);
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => FILE_RE.test(n));
  } catch {
    /* dossier absent */
  }
  // L'horodatage est dans le nom : tri décroissant = plus récent d'abord.
  const stampOf = (n: string) => Number(FILE_RE.exec(n)![3].split("-")[0]);
  names.sort((a, b) => stampOf(b) - stampOf(a) || b.localeCompare(a));
  return {
    total: names.length,
    files: names.slice(offset, offset + limit).map((n) => `${CLASSES[cls].dir}/${n}`),
  };
}

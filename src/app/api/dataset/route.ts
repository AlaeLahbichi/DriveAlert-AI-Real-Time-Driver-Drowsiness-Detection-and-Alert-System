import { connection } from "next/server";
import { deleteFiles, getStats, saveCaptures } from "@/lib/datasetStore";
import type { SaveRequest } from "@/lib/datasetClasses";

// Statistiques de la base (nombre d'images par classe et par personne).
export async function GET() {
  await connection();
  return Response.json(await getStats());
}

// Enregistre une capture (1 à 3 images découpées + étiquettes).
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SaveRequest;
    const saved = await saveCaptures(body);
    return Response.json({ saved });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

// Supprime des images (et leurs lignes dans labels.csv).
export async function DELETE(request: Request) {
  try {
    const { files } = (await request.json()) as { files: string[] };
    if (!Array.isArray(files)) throw new Error("Liste de fichiers manquante");
    return Response.json({ removed: await deleteFiles(files.map(String)) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

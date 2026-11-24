import type { NextRequest } from "next/server";
import { readImage } from "@/lib/datasetStore";

// Sert une image de data/ pour l'affichage dans la galerie de vérification.
export async function GET(request: NextRequest) {
  const file = request.nextUrl.searchParams.get("file") ?? "";
  const buf = await readImage(file);
  if (!buf) return new Response("Introuvable", { status: 404 });
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}

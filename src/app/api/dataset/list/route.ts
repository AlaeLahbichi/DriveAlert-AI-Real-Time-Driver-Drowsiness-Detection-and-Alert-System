import type { NextRequest } from "next/server";
import { listClass } from "@/lib/datasetStore";
import { CLASS_KEYS, type ClassKey } from "@/lib/datasetClasses";

// Liste paginée des images d'une classe (plus récentes d'abord).
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const cls = q.get("cls") as ClassKey;
  if (!CLASS_KEYS.includes(cls)) return Response.json({ error: "Classe inconnue" }, { status: 400 });
  const offset = Math.max(0, Number(q.get("offset")) || 0);
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 60));
  return Response.json(await listClass(cls, offset, limit));
}

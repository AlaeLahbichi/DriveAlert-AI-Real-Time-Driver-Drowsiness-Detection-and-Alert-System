import { createSplit } from "@/lib/datasetStore";

// Crée data/split.csv : 70 % entraînement, 15 % validation, 15 % test, par personne.
export async function POST() {
  try {
    return Response.json(await createSplit());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

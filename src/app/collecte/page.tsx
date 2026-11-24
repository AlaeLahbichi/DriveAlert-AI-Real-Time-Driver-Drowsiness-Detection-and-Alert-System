import type { Metadata } from "next";
import DataCollector from "@/components/DataCollector";

export const metadata: Metadata = { title: "Collecte de données · Détection de somnolence" };

export default function CollectePage() {
  return <DataCollector />;
}

import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

export const metadata: Metadata = { title: "Tableau de bord · Détection de somnolence" };

export default function TableauDeBordPage() {
  return <Dashboard />;
}

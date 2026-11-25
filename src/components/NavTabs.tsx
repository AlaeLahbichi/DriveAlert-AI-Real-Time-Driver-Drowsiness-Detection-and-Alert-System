"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Onglets regroupés par usage : détecter, analyser, préparer les données. */
const GROUPS = [
  {
    label: "Détection",
    tabs: [
      { href: "/", label: "V1 · Google", hint: "MediaPipe" },
      { href: "/mon-modele", label: "V2 · Mon modèle", hint: "MobileNetV2" },
    ],
  },
  { label: "Analyse", tabs: [{ href: "/tableau-de-bord", label: "Tableau de bord", hint: "KPI · graphes" }] },
  { label: "Données", tabs: [{ href: "/collecte", label: "Collecte", hint: "dataset" }] },
];

export default function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-30 border-b border-line bg-nav/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-2.5">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight text-ink">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm">◉</span>
          DriveAlert <span className="font-medium text-muted">AI</span>
        </Link>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {GROUPS.map((g) => (
            <div key={g.label} className="flex items-center gap-1.5">
              <span className="hidden text-[11px] font-semibold uppercase tracking-wider text-faint md:inline">{g.label}</span>
              <div className="flex gap-1 rounded-xl border border-line bg-surface p-1">
                {g.tabs.map((t) => {
                  const active = pathname === t.href;
                  return (
                    <Link
                      key={t.href}
                      href={t.href}
                      aria-current={active ? "page" : undefined}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                        active ? "bg-brand text-white shadow" : "text-soft hover:bg-raised hover:text-ink"
                      }`}
                    >
                      {t.label}
                      <span className={`ml-1.5 hidden text-[11px] lg:inline ${active ? "text-white/70" : "text-faint"}`}>
                        {t.hint}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}

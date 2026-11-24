"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Détection (version 1)" },
  { href: "/collecte", label: "Collecte de données" },
];

/** Onglets en haut de toutes les pages. */
export default function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-white/10 bg-[#0B1422] px-6 pt-2">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium transition ${
              active ? "bg-[#0F1B2D] text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

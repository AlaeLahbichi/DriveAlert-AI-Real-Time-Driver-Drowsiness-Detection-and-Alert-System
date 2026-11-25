"use client";

import type { Iot } from "@/lib/iot";

const BROKER_LABEL = { connexion: "Connexion…", connecte: "Connecté", erreur: "Erreur" } as const;
const BROKER_COLOR = { connexion: "#F2A541", connecte: "#2A9D8F", erreur: "#E5383B" } as const;

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />;
}

/** Carte « Boîtier IoT » : état de la liaison MQTT avec l'ESP32. */
export default function IotPanel({ iot }: { iot: Iot }) {
  const { broker, brokerError, sent, position, positionError, sharePosition } = iot;
  return (
    <section className="rounded-2xl border border-white/10 bg-[#16243A] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Boîtier IoT (ESP32 · MQTT)</h2>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-slate-400">Broker MQTT</span>
          <span className="flex items-center gap-2">
            <Dot color={BROKER_COLOR[broker]} />
            {BROKER_LABEL[broker]}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-400">Dernier niveau envoyé</span>
          <span className="font-mono">
            {sent ? `${sent.niveau} · ${new Date(sent.at).toLocaleTimeString("fr-FR")}` : "–"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-400">Position (pour le SOS)</span>
          {position ? (
            <span className="font-mono text-xs">
              {position.lat.toFixed(4)}, {position.lon.toFixed(4)}
            </span>
          ) : (
            <button
              onClick={sharePosition}
              className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
            >
              Partager ma position
            </button>
          )}
        </div>
        {brokerError && <p className="text-xs text-[#E76F51]">MQTT : {brokerError}</p>}
        {positionError && <p className="text-xs text-[#E76F51]">{positionError}</p>}
      </div>
    </section>
  );
}

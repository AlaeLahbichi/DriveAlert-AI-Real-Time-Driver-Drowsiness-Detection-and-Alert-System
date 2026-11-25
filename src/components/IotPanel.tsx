"use client";

import type { BoxLog, Iot } from "@/lib/iot";

const BROKER_LABEL = { connexion: "Connexion…", connecte: "Connecté", erreur: "Erreur" } as const;
const BROKER_COLOR = { connexion: "#F2A541", connecte: "#2A9D8F", erreur: "#E5383B" } as const;

/** Libellés lisibles des événements du journal de l'ESP32 (iot/src/main.cpp). */
const LOG_LABEL: Record<string, string> = {
  DEMARRAGE: "Boîtier allumé",
  AUTOTEST: "Auto-test",
  WIFI_OK: "Wi-Fi connecté",
  WIFI_PERDU: "Wi-Fi perdu",
  MQTT_OK: "MQTT connecté",
  MQTT_PERDU: "MQTT perdu",
  CONNEXION: "Plateforme détectée",
  DECONNEXION: "Plateforme perdue",
  NIVEAU: "Niveau reçu",
  ACK: "Alerte vue (bouton)",
  PAUSE_RAPPEL: "Rappel de pause",
  PAUSE_OK: "Pause acceptée",
  PAUSE_ANNULEE: "Pause annulée",
  SOS_ENVOYE: "SOS WhatsApp envoyé",
  SOS_RAPPEL: "Rappel SOS envoyé",
  SOS_FIN: "Fin du SOS",
  SOS_ECHEC: "Échec du SOS",
};

function logColor(e: BoxLog) {
  if (e.evenement.startsWith("SOS") && e.evenement !== "SOS_FIN") return "#E5383B";
  if (e.evenement === "ACK" || e.evenement === "PAUSE_OK" || e.evenement === "SOS_FIN") return "#2A9D8F";
  if (e.evenement.startsWith("PAUSE") || e.evenement.endsWith("PERDU") || e.evenement === "DECONNEXION") return "#F2A541";
  return undefined;
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-400">{label}</span>
      <span className="flex items-center gap-2 text-right">{children}</span>
    </div>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString("fr-FR");

/** Carte « Boîtier IoT » : liaison MQTT, état de l'ESP32, réponse du conducteur et journal du boîtier. */
export default function IotPanel({ iot }: { iot: Iot }) {
  const { broker, brokerError, sent, position, positionError, box, lastAck, log, sharePosition } = iot;
  const lastSos = log.find((e) => e.evenement === "SOS_ENVOYE" || e.evenement === "SOS_FIN");

  return (
    <section className="rounded-2xl border border-white/10 bg-[#16243A] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Boîtier IoT (ESP32 · MQTT)</h2>

      {lastSos?.evenement === "SOS_ENVOYE" && (
        <p className="mb-3 rounded-lg bg-[#E5383B]/20 px-3 py-2 text-sm font-semibold text-[#ff8a8c]">
          🚨 SOS WhatsApp envoyé ({lastSos.temps}) : le conducteur n’a pas répondu.
        </p>
      )}

      <div className="space-y-2 text-sm">
        <Row label="Broker MQTT">
          <Dot color={BROKER_COLOR[broker]} />
          {BROKER_LABEL[broker]}
        </Row>
        <Row label="Boîtier ESP32">
          {box === null ? (
            <>
              <Dot color="#64748B" />
              Jamais vu
            </>
          ) : box.enLigne ? (
            <>
              <Dot color="#2A9D8F" />
              En ligne{box.sos === "simulation" ? " · SOS simulé" : box.sos === "whatsapp" ? " · SOS WhatsApp" : ""}
            </>
          ) : (
            <>
              <Dot color="#E5383B" />
              Hors ligne
            </>
          )}
        </Row>
        <Row label="Dernier niveau envoyé">
          <span className="font-mono">{sent ? `${sent.niveau} · ${time(sent.at)}` : "–"}</span>
        </Row>
        <Row label="Réponse du conducteur">
          {lastAck ? (
            <span className="text-[#2A9D8F]">
              {lastAck.type === "pause" ? "Pause acceptée" : `Alerte ${lastAck.niveau} vue`} · {time(lastAck.at)}
            </span>
          ) : (
            <span className="text-slate-500">aucune</span>
          )}
        </Row>
        <Row label="Position (pour le SOS)">
          {position ? (
            <span className="font-mono text-xs">
              {position.lat.toFixed(4)}, {position.lon.toFixed(4)}
            </span>
          ) : (
            <button onClick={sharePosition} className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
              Partager ma position
            </button>
          )}
        </Row>
        {brokerError && <p className="text-xs text-[#E76F51]">MQTT : {brokerError}</p>}
        {positionError && <p className="text-xs text-[#E76F51]">{positionError}</p>}
      </div>

      <h3 className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Journal du boîtier</h3>
      {log.length === 0 ? (
        <p className="text-xs text-slate-500">Aucun événement reçu du boîtier.</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto pr-1 text-xs">
          {log.map((e) => (
            <li key={e.id} className="flex gap-2 rounded-md bg-white/5 px-2 py-1">
              <span className="shrink-0 font-mono text-slate-400">{e.temps.split(" ").pop()}</span>
              <span style={{ color: logColor(e) }}>
                {LOG_LABEL[e.evenement] ?? e.evenement}
                {e.detail && <span className="text-slate-400"> · {e.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

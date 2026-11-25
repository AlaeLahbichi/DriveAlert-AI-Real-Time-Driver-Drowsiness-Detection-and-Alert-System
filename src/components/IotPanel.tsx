"use client";

import { memo } from "react";
import { BOX_EVENT_LABEL as LOG_LABEL, type BoxLog, type Iot } from "@/lib/iot";
import { C } from "@/lib/theme";

const BROKER_LABEL = { connexion: "Connexion…", connecte: "Connecté", erreur: "Erreur" } as const;
const BROKER_COLOR = { connexion: C.warn, connecte: C.ok, erreur: C.danger };


function logColor(e: BoxLog) {
  if (e.evenement.startsWith("SOS") && e.evenement !== "SOS_FIN") return C.danger;
  if (e.evenement === "ACK" || e.evenement === "PAUSE_OK" || e.evenement === "SOS_FIN") return C.ok;
  if (e.evenement.startsWith("PAUSE") || e.evenement.endsWith("PERDU") || e.evenement === "DECONNEXION") return C.warn;
  return undefined;
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2 text-right">{children}</span>
    </div>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString("fr-FR");

/** Onglet « Boîtier IoT » : liaison MQTT, état de l'ESP32, réponse du conducteur et journal du boîtier. */
function IotPanel({ iot }: { iot: Iot }) {
  const { broker, brokerError, sent, position, positionError, box, lastAck, log, latency, ping, sharePosition } = iot;
  const lastSos = log.find((e) => e.evenement === "SOS_ENVOYE" || e.evenement === "SOS_FIN");

  return (
    <div>

      {lastSos?.evenement === "SOS_ENVOYE" && (
        <p className="mb-3 rounded-lg bg-danger/20 px-3 py-2 text-sm font-semibold text-ink">
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
              <Dot color={C.faint} />
              Jamais vu
            </>
          ) : box.enLigne ? (
            <>
              <Dot color={C.ok} />
              En ligne{box.sos === "simulation" ? " · SOS simulé" : box.sos === "whatsapp" ? " · SOS WhatsApp" : ""}
            </>
          ) : (
            <>
              <Dot color={C.danger} />
              Hors ligne
            </>
          )}
        </Row>
        <Row label="Dernier niveau envoyé">
          <span className="font-mono">{sent ? `${sent.niveau} · ${time(sent.at)}` : "–"}</span>
        </Row>
        <Row label="Latence (aller-retour)">
          {latency ? (
            <span className="font-mono" title={`moyenne ${latency.avg.toFixed(0)} ms · min ${latency.min} · max ${latency.max} · ${latency.count} mesures`}>
              <span style={{ color: latency.last < 300 ? C.ok : latency.last < 800 ? C.warn : C.danger }}>
                {latency.last} ms
              </span>
              <span className="text-xs text-muted"> · moy. {latency.avg.toFixed(0)}</span>
            </span>
          ) : (
            <span className="text-faint">–</span>
          )}
          <button
            onClick={ping}
            disabled={broker !== "connecte" || !box?.enLigne}
            className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-40"
          >
            Tester
          </button>
        </Row>
        <Row label="Réponse du conducteur">
          {lastAck ? (
            <span className="text-brand">
              {lastAck.type === "pause" ? "Pause acceptée" : `Alerte ${lastAck.niveau} vue`} · {time(lastAck.at)}
            </span>
          ) : (
            <span className="text-faint">aucune</span>
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
        {brokerError && <p className="text-xs text-danger">MQTT : {brokerError}</p>}
        {positionError && <p className="text-xs text-danger">{positionError}</p>}
      </div>

      <h3 className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Journal du boîtier</h3>
      {log.length === 0 ? (
        <p className="text-xs text-faint">Aucun événement reçu du boîtier.</p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-xs">
          {log.map((e) => (
            <li key={e.id} className="flex gap-2 rounded-md bg-raised px-2 py-1">
              <span className="shrink-0 font-mono text-muted">{e.temps.split(" ").pop()}</span>
              <span style={{ color: logColor(e) }}>
                {LOG_LABEL[e.evenement] ?? e.evenement}
                {e.detail && <span className="text-muted"> · {e.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Mémorisé : ne se redessine que si l'état du boîtier change (pas à chaque image de la caméra).
export default memo(IotPanel);

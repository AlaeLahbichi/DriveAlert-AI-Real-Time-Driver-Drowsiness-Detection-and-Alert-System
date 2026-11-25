"use client";

// Lien plateforme <-> boîtier ESP32 par MQTT (broker public HiveMQ, en WebSocket sécurisé).
// La plateforme publie le niveau d'alerte à chaque changement, plus un heartbeat toutes les 2 s,
// et écoute le boîtier : appui sur le bouton (ack), journal des événements, état en ligne.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MqttClient } from "mqtt";
import type { Level } from "./engine";
import { appendAck, appendBox, appendLatency } from "./logStore";

export const IOT_BROKER = "wss://broker.hivemq.com:8884/mqtt";
/** Préfixe des topics : identique à PREFIXE dans iot/src/main.cpp. */
export const IOT_PREFIX = "drivealert/pfa-alae-01/";
const HEARTBEAT_MS = 2000;

export type BrokerStatus = "connexion" | "connecte" | "erreur";
export type Position = { lat: number; lon: number; precision: number };
/** État publié (retenu) par le boîtier ; enLigne:false est publié par le broker si l'ESP32 disparaît. */
export type BoxState = { enLigne: boolean; ip?: string; sos?: "whatsapp" | "simulation" };
export type BoxAck = { type: "alerte" | "pause"; niveau: number; temps: string; at: number };
export type BoxLog = { id: number; temps: string; evenement: string; niveau: number; detail: string };
/** Latence aller-retour plateforme -> broker -> ESP32 -> broker -> plateforme (ms). */
export type Latency = { last: number; avg: number; min: number; max: number; count: number };
const MAX_LOG = 30;

/** Libellés lisibles des événements du journal de l'ESP32 (iot/src/main.cpp). */
export const BOX_EVENT_LABEL: Record<string, string> = {
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

export function useIot(version: "v1" | "v2") {
  const clientRef = useRef<MqttClient | null>(null);
  const alerteRef = useRef<{ niveau: Level; cause: string }>({ niveau: 0, cause: "" });
  const positionRef = useRef<Position | null>(null);
  /** Moment où l'alerte en cours a commencé (pour le temps de réaction du conducteur). */
  const alertSinceRef = useRef<number | null>(null);
  const [broker, setBroker] = useState<BrokerStatus>("connexion");
  const [brokerError, setBrokerError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ niveau: Level; at: number } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [box, setBox] = useState<BoxState | null>(null);
  const [lastAck, setLastAck] = useState<BoxAck | null>(null);
  const [log, setLog] = useState<BoxLog[]>([]);
  const [latency, setLatency] = useState<Latency | null>(null);

  /** Message envoyé au boîtier (alerte et heartbeat ont le même format). */
  const payload = useCallback(() => {
    const p = positionRef.current;
    return JSON.stringify({
      ...alerteRef.current,
      version,
      t: Date.now(),
      ...(p ? { lat: p.lat, lon: p.lon } : {}),
    });
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    let client: MqttClient | null = null;
    import("mqtt")
      .then((mod) => {
        if (cancelled) return;
        // Selon le bundler, connect est exporté directement ou sous « default ».
        const connect = mod.connect ?? (mod as unknown as { default: typeof mod }).default.connect;
        client = connect(IOT_BROKER, {
          clientId: `drivealert-web-${Math.random().toString(16).slice(2, 10)}`,
          reconnectPeriod: 3000,
          connectTimeout: 8000,
        });
        clientRef.current = client;
        client.on("connect", () => {
          setBroker("connecte");
          setBrokerError(null);
          client?.subscribe([IOT_PREFIX + "etat", IOT_PREFIX + "ack", IOT_PREFIX + "journal", IOT_PREFIX + "recu"]);
        });
        let nextId = 0;
        client.on("message", (topic, raw) => {
          if (raw.length === 0) {
            if (topic === IOT_PREFIX + "etat") setBox(null); // état retenu effacé
            return;
          }
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(raw.toString());
          } catch {
            return;
          }
          const name = topic.slice(IOT_PREFIX.length);
          if (name === "etat") setBox(data as BoxState);
          else if (name === "ack") {
            const ack = { ...(data as Omit<BoxAck, "at">), at: Date.now() };
            setLastAck(ack);
            const since = alertSinceRef.current;
            appendAck({
              at: ack.at,
              type: ack.type,
              niveau: ack.niveau,
              reactionMs: ack.type === "alerte" && since ? ack.at - since : null,
            });
          }
          else if (name === "recu" && typeof data.t === "number") {
            const ms = Date.now() - data.t;
            appendLatency({ at: Date.now(), ms });
            setLatency((l) =>
              l
                ? {
                    last: ms,
                    avg: (l.avg * l.count + ms) / (l.count + 1),
                    min: Math.min(l.min, ms),
                    max: Math.max(l.max, ms),
                    count: l.count + 1,
                  }
                : { last: ms, avg: ms, min: ms, max: ms, count: 1 },
            );
          } else if (name === "journal") {
            const entry = data as Omit<BoxLog, "id">;
            setLog((prev) => [{ ...entry, id: nextId++ }, ...prev].slice(0, MAX_LOG));
            appendBox({ ...entry, at: Date.now() });
          }
        });
        client.on("reconnect", () => setBroker("connexion"));
        client.on("offline", () => setBroker("connexion"));
        client.on("error", (e) => {
          setBroker("erreur");
          setBrokerError(e.message);
        });
      })
      .catch((e: Error) => {
        setBroker("erreur");
        setBrokerError(e.message);
      });

    const heartbeat = setInterval(() => {
      const c = clientRef.current;
      if (c?.connected) c.publish(IOT_PREFIX + "heartbeat", payload());
    }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      client?.end(true);
      clientRef.current = null;
    };
  }, [payload]);

  /** Envoie une alerte de test (niveau inchangé) pour mesurer la latence avec le boîtier. */
  const ping = useCallback(() => {
    const c = clientRef.current;
    if (c?.connected) c.publish(IOT_PREFIX + "alerte", payload());
  }, [payload]);

  /** À appeler quand le niveau change : prévient le boîtier tout de suite. */
  const publishLevel = useCallback(
    (niveau: Level, cause: string) => {
      if (niveau === 0) alertSinceRef.current = null;
      else if (alerteRef.current.niveau === 0) alertSinceRef.current = Date.now();
      alerteRef.current = { niveau, cause };
      const c = clientRef.current;
      if (!c?.connected) return;
      c.publish(IOT_PREFIX + "alerte", payload()); // QoS 0 : le plus rapide (le heartbeat corrige une perte)
      setSent({ niveau, at: Date.now() });
    },
    [payload],
  );

  /** Partage la position du navigateur : le boîtier la met dans le SOS WhatsApp. */
  const sharePosition = useCallback(() => {
    if (!navigator.geolocation) {
      setPositionError("Géolocalisation non disponible dans ce navigateur");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy };
        positionRef.current = pos;
        setPosition(pos);
        setPositionError(null);
      },
      (e) => setPositionError(e.message),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  // Objet stable tant que rien ne change : la carte « Boîtier IoT » ne se redessine pas à chaque image.
  return useMemo(
    () => ({ broker, brokerError, sent, position, positionError, box, lastAck, log, latency, ping, publishLevel, sharePosition }),
    [broker, brokerError, sent, position, positionError, box, lastAck, log, latency, ping, publishLevel, sharePosition],
  );
}

export type Iot = ReturnType<typeof useIot>;

"use client";

// Lien plateforme <-> boîtier ESP32 par MQTT (broker public HiveMQ, en WebSocket sécurisé).
// La plateforme publie le niveau d'alerte à chaque changement, plus un heartbeat toutes les 2 s.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MqttClient } from "mqtt";
import type { Level } from "./engine";

export const IOT_BROKER = "wss://broker.hivemq.com:8884/mqtt";
/** Préfixe des topics : identique à PREFIXE dans iot/src/main.cpp. */
export const IOT_PREFIX = "drivealert/pfa-alae-01/";
const HEARTBEAT_MS = 2000;

export type BrokerStatus = "connexion" | "connecte" | "erreur";
export type Position = { lat: number; lon: number; precision: number };

export function useIot(version: "v1" | "v2") {
  const clientRef = useRef<MqttClient | null>(null);
  const alerteRef = useRef<{ niveau: Level; cause: string }>({ niveau: 0, cause: "" });
  const positionRef = useRef<Position | null>(null);
  const [broker, setBroker] = useState<BrokerStatus>("connexion");
  const [brokerError, setBrokerError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ niveau: Level; at: number } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);

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

  /** À appeler quand le niveau change : prévient le boîtier tout de suite. */
  const publishLevel = useCallback(
    (niveau: Level, cause: string) => {
      alerteRef.current = { niveau, cause };
      const c = clientRef.current;
      if (!c?.connected) return;
      c.publish(IOT_PREFIX + "alerte", payload(), { qos: 1 });
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

  return { broker, brokerError, sent, position, positionError, publishLevel, sharePosition };
}

export type Iot = ReturnType<typeof useIot>;

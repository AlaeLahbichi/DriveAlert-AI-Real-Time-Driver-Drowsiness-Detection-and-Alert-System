"use client";

// Journal persistant de la plateforme (localStorage du navigateur) : sessions de détection,
// journal du boîtier ESP32, réponses du conducteur (bouton) et latences MQTT.
// Lu par l'onglet « Tableau de bord » ; rien n'est envoyé sur Internet.

import { useSyncExternalStore } from "react";
import type { EventKind, Level } from "./engine";

export type SessionEvent = { at: number; kind: EventKind; level?: Level; message: string };
export type SessionLog = {
  id: string;
  variant: "v1" | "v2";
  start: number; // epoch ms
  end: number; // epoch ms (mis à jour pendant la session)
  levelMs: [number, number, number, number]; // temps passé à chaque niveau
  timeline: { at: number; level: Level }[]; // changements de niveau
  events: SessionEvent[];
};
export type BoxEntry = { at: number; temps: string; evenement: string; niveau: number; detail: string };
export type AckEntry = { at: number; type: "alerte" | "pause"; niveau: number; reactionMs: number | null };
export type LatencyEntry = { at: number; ms: number };
export type Logs = { sessions: SessionLog[]; box: BoxEntry[]; acks: AckEntry[]; latency: LatencyEntry[] };

const KEY = "drivealert.logs.v1";
const CHANGE = "drivealert-logs";
const MAX = { sessions: 60, events: 400, box: 600, acks: 300, latency: 300 };
const EMPTY: Logs = { sessions: [], box: [], acks: [], latency: [] };

let cache: Logs | null = null;

function read(): Logs {
  if (cache) return cache;
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Logs>) } : EMPTY;
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function write(next: Logs) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // stockage plein : on garde la version en mémoire
  }
  window.dispatchEvent(new Event(CHANGE));
}

const keep = <T,>(list: T[], max: number) => (list.length > max ? list.slice(list.length - max) : list);

/** Ajoute ou met à jour une session (même id). */
export function saveSession(s: SessionLog) {
  const logs = read();
  // Copie : la session en cours continue d'être modifiée par la boucle de détection.
  const session: SessionLog = { ...s, levelMs: [...s.levelMs], timeline: [...s.timeline], events: keep([...s.events], MAX.events) };
  const others = logs.sessions.filter((x) => x.id !== s.id);
  write({ ...logs, sessions: keep([...others, session], MAX.sessions) });
}

export function appendBox(e: BoxEntry) {
  const logs = read();
  write({ ...logs, box: keep([...logs.box, e], MAX.box) });
}

export function appendAck(a: AckEntry) {
  const logs = read();
  write({ ...logs, acks: keep([...logs.acks, a], MAX.acks) });
}

export function appendLatency(l: LatencyEntry) {
  const logs = read();
  write({ ...logs, latency: keep([...logs.latency, l], MAX.latency) });
}

export function clearLogs() {
  write(EMPTY);
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null; // un autre onglet a écrit
    cb();
  };
  window.addEventListener(CHANGE, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE, cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** Les logs, mis à jour en direct (même onglet ou autre onglet). */
export function useLogs(): Logs {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** Tous les logs en CSV (séparateur « ; » pour Excel en français). */
export function logsToCsv(logs: Logs): string {
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const date = (at: number) => new Date(at).toLocaleString("fr-FR");
  const rows: string[][] = [["date", "source", "type", "niveau", "détail"].map(esc)];
  for (const s of logs.sessions)
    for (const e of s.events) rows.push([date(e.at), `plateforme ${s.variant.toUpperCase()}`, e.kind, e.level ?? "", e.message].map(esc));
  for (const b of logs.box) rows.push([date(b.at), "boîtier", b.evenement, b.niveau, b.detail].map(esc));
  for (const a of logs.acks)
    rows.push([date(a.at), "conducteur", `ack ${a.type}`, a.niveau, a.reactionMs != null ? `${a.reactionMs} ms` : ""].map(esc));
  return rows.map((r) => r.join(";")).join("\n");
}

"use client";

// Aires de repos proches (OpenStreetMap, API Overpass : gratuite, sans clé).
// Seule la position partagée par le conducteur est envoyée, et uniquement pour cette recherche.

import { useEffect, useState } from "react";

export type RestArea = {
  name: string;
  kind: "rest" | "services" | "fuel";
  lat: number;
  lon: number;
  distanceKm: number;
};

export const REST_KIND_LABEL: Record<RestArea["kind"], string> = {
  rest: "Aire de repos",
  services: "Aire de services",
  fuel: "Station-service",
};

// Serveurs publics parfois lents (10 à 90 s) : on interroge les trois en même temps et on garde le premier.
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; areas: RestArea[] }>();

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

type OverpassElement = { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

/** Les 3 arrêts les plus proches (aires de repos et de services d'abord, stations-service ensuite). */
export async function findRestAreas(lat: number, lon: number, signal?: AbortSignal): Promise<RestArea[]> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`; // ~1 km : inutile de redemander à chaque mouvement
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.areas;

  const query = `[out:json][timeout:10];(
    nwr["highway"="rest_area"](around:30000,${lat},${lon});
    nwr["highway"="services"](around:30000,${lat},${lon});
    nwr["amenity"="fuel"](around:10000,${lat},${lon});
  );out center 60;`;
  const race = new AbortController();
  const stop = () => race.abort();
  signal?.addEventListener("abort", stop);
  const ask = async (url: string) => {
    const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: race.signal });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return ((await res.json()) as { elements: OverpassElement[] }).elements;
  };
  try {
    const elements = await Promise.any(SERVERS.map(ask));
    const areas = elements
      .map((e): RestArea | null => {
        const la = e.lat ?? e.center?.lat;
        const lo = e.lon ?? e.center?.lon;
        if (la === undefined || lo === undefined) return null;
        const t = e.tags ?? {};
        const kind: RestArea["kind"] = t.highway === "rest_area" ? "rest" : t.highway === "services" ? "services" : "fuel";
        const name = t.name ?? t.brand ?? t.operator ?? REST_KIND_LABEL[kind];
        return { name, kind, lat: la, lon: lo, distanceKm: distanceKm(lat, lon, la, lo) };
      })
      .filter((a): a is RestArea => a !== null)
      // Une vraie aire de repos un peu plus loin vaut mieux qu'une station juste à côté.
      .sort((a, b) => a.distanceKm * (a.kind === "fuel" ? 1.5 : 1) - b.distanceKm * (b.kind === "fuel" ? 1.5 : 1))
      .slice(0, 3);
    cache.set(key, { at: Date.now(), areas });
    return areas;
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error("Recherche impossible (serveurs OpenStreetMap indisponibles)");
  } finally {
    stop(); // annule les serveurs plus lents
    signal?.removeEventListener("abort", stop);
  }
}

/** Itinéraire Google Maps vers un point. */
export const directionsUrl = (lat: number, lon: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

/** Recherche de secours si OpenStreetMap ne répond pas. */
export const searchUrl = (lat: number, lon: number) =>
  `https://www.google.com/maps/search/aire+de+repos/@${lat},${lon},12z`;

export type RestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; areas: RestArea[] }
  | { status: "error"; message: string };

/** Charge les aires dès que la position est connue (le résultat est prêt quand l'alerte arrive). */
export function useRestAreas(position: { lat: number; lon: number } | null, enabled: boolean): RestState {
  const [state, setState] = useState<RestState>({ status: "idle" });
  const lat = position?.lat;
  const lon = position?.lon;
  useEffect(() => {
    if (!enabled || lat === undefined || lon === undefined) return;
    const ctrl = new AbortController();
    // Différé : pas de setState synchrone dans l'effet.
    const timer = setTimeout(() => setState((s) => (s.status === "ok" ? s : { status: "loading" })), 0);
    findRestAreas(lat, lon, ctrl.signal)
      .then((areas) => setState({ status: "ok", areas }))
      .catch((e: Error) => {
        if (!ctrl.signal.aborted) setState({ status: "error", message: e.message });
      });
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [lat, lon, enabled]);
  return state;
}

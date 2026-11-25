"use client";

/**
 * Ouvre la webcam. Le navigateur ne donne accès à la caméra que dans un contexte sécurisé
 * (https ou localhost) : sinon navigator.mediaDevices n'existe pas. On l'explique clairement.
 */
export async function openCamera(video: MediaTrackConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    const host = window.location.hostname;
    throw new Error(
      window.isSecureContext
        ? "ce navigateur ne permet pas l'accès à la caméra."
        : `le navigateur bloque la caméra sur http://${host}. Ouvrez http://localhost:3000 sur cet ordinateur, ` +
          "ou lancez « npm run dev:https » puis ouvrez l'adresse en https.",
    );
  }
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

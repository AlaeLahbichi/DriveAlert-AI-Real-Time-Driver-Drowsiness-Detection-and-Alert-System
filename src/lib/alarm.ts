// Alarme sonore et vocale, générée par le navigateur (Web Audio + synthèse vocale).
// Niveau 1 : un « ding » doux. Niveau 2 : bip toutes les secondes.
// Niveau 3 : bips rapides et message vocal.

import type { Level } from "./engine";

export class AlarmPlayer {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private level: Level = 0;
  private lastSpoken = 0;
  muted = false;

  /** À appeler depuis un clic (les navigateurs bloquent le son sans geste de l'utilisateur). */
  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private beep(freq: number, durationS: number, volume = 0.25) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durationS);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + durationS + 0.02);
  }

  private speak(text: string) {
    if (this.muted || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const now = Date.now();
    if (now - this.lastSpoken < 6000) return;
    this.lastSpoken = now;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  }

  setLevel(level: Level) {
    if (level === this.level) return;
    const rising = level > this.level;
    this.level = level;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    if (level === 1 && rising) {
      this.beep(880, 0.25, 0.15);
    } else if (level === 2) {
      const tick = () => this.beep(1000, 0.18);
      tick();
      this.timer = setInterval(tick, 1000);
      if (typeof navigator !== "undefined") navigator.vibrate?.([200, 100, 200]);
    } else if (level === 3) {
      const tick = () => {
        this.beep(1400, 0.12, 0.35);
        setTimeout(() => this.beep(1400, 0.12, 0.35), 180);
      };
      tick();
      this.timer = setInterval(tick, 450);
      this.speak("Attention ! Réveillez-vous et arrêtez-vous dès que possible.");
      if (typeof navigator !== "undefined") navigator.vibrate?.([500, 150, 500, 150, 500]);
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted && typeof window !== "undefined") window.speechSynthesis?.cancel();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    void this.ctx?.close();
    this.ctx = null;
  }
}

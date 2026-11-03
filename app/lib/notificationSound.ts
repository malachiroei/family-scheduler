import { normalizeNotificationCategory, type NotificationLevel } from "@/app/lib/notificationCategory";

type AudioCtor = typeof AudioContext;

const audioWindow = () => {
  if (typeof window === "undefined") return null;
  const ctor = window.AudioContext
    || (window as Window & { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  return ctor ?? null;
};

let sharedContext: AudioContext | null = null;
let activeNodes: Array<{ osc: OscillatorNode; gain: GainNode }> = [];

const context = () => {
  const Ctor = audioWindow();
  if (!Ctor) return null;
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new Ctor();
  }
  return sharedContext;
};

const stopActive = (ctx: AudioContext) => {
  const now = ctx.currentTime;
  for (const node of activeNodes) {
    try {
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(0.0001, now);
      node.osc.stop(now + 0.03);
    } catch {
      // The oscillator may already have stopped.
    }
  }
  activeNodes = [];
};

const tone = (ctx: AudioContext, frequency: number, start: number, duration: number, peak = 0.2) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
  activeNodes.push({ osc, gain });
};

/** Preview or alert tone for a notification level. Silent does nothing. */
export const playNotificationLevel = async (level: NotificationLevel) => {
  if (level === "silent") return;
  const ctx = context();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }
  stopActive(ctx);
  const start = ctx.currentTime + 0.02;
  if (level === "normal") {
    tone(ctx, 800, start, 0.18, 0.22);
    return;
  }
  if (level === "medium") {
    tone(ctx, 600, start, 0.16, 0.2);
    tone(ctx, 900, start + 0.18, 0.22, 0.2);
    return;
  }
  const pattern = [660, 880, 990];
  for (let repeat = 0; repeat < 2; repeat += 1) {
    pattern.forEach((frequency, index) => {
      tone(ctx, frequency, start + repeat * 0.72 + index * 0.16, 0.14, 0.24);
    });
  }
};

export const playNotificationLevelFromPayload = (value: unknown) => {
  const level = normalizeNotificationCategory(value);
  if (!level || level === "silent") return;
  void playNotificationLevel(level);
};

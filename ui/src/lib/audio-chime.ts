// Web Audio two-tone notification chime for Paperclip

const MUTE_STORAGE_KEY = "paperclip.approval_chime_muted";
const DEFAULT_COOLDOWN_MS = 10_000;

const lastPlayedByRequestId = new Map<string, number>();

export function isMuted(): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return false;
  }
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? "true" : "false");
  } catch {
    // Ignore storage errors
  }
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  setMuted(next);
  return next;
}

export const getMuted = isMuted;

export function isDocumentVisible(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState === "visible";
}

export function isCooldownActive(
  requestId: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  now: number = Date.now()
): boolean {
  const last = lastPlayedByRequestId.get(requestId);
  if (last === undefined) {
    return false;
  }
  return now - last < cooldownMs;
}

export function recordPlayed(requestId: string, now: number = Date.now()): void {
  lastPlayedByRequestId.set(requestId, now);
}

export function clearCooldowns(): void {
  lastPlayedByRequestId.clear();
}

export function canPlayChime(
  requestId?: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS
): boolean {
  if (isMuted()) {
    return false;
  }
  if (!isDocumentVisible()) {
    return false;
  }
  if (requestId && isCooldownActive(requestId, cooldownMs)) {
    return false;
  }
  return true;
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return null;
  }
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    try {
      sharedAudioContext = new AudioCtx();
    } catch {
      return null;
    }
  }
  return sharedAudioContext;
}

export async function playTwoToneChime(audioCtx: AudioContext): Promise<void> {
  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {
      // Resume may fail if user hasn't interacted
    }
  }

  const now = audioCtx.currentTime;
  const tone1Freq = 587.33; // D5
  const tone2Freq = 880.0; // A5
  const tone1Duration = 0.12;
  const tone2Duration = 0.2;

  // Tone 1
  const osc1 = audioCtx.createOscillator();
  const gain1 = audioCtx.createGain();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(tone1Freq, now);
  gain1.gain.setValueAtTime(0, now);
  gain1.gain.linearRampToValueAtTime(0.2, now + 0.02);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + tone1Duration);

  osc1.connect(gain1);
  gain1.connect(audioCtx.destination);
  osc1.start(now);
  osc1.stop(now + tone1Duration);

  // Tone 2
  const tone2Start = now + 0.1;
  const osc2 = audioCtx.createOscillator();
  const gain2 = audioCtx.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(tone2Freq, tone2Start);
  gain2.gain.setValueAtTime(0, tone2Start);
  gain2.gain.linearRampToValueAtTime(0.25, tone2Start + 0.02);
  gain2.gain.exponentialRampToValueAtTime(0.001, tone2Start + tone2Duration);

  osc2.connect(gain2);
  gain2.connect(audioCtx.destination);
  osc2.start(tone2Start);
  osc2.stop(tone2Start + tone2Duration);
}

export interface PlayChimeOptions {
  cooldownMs?: number;
}

export async function playApprovalChime(
  requestId?: string,
  options?: PlayChimeOptions
): Promise<boolean> {
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (!canPlayChime(requestId, cooldownMs)) {
    return false;
  }

  if (requestId) {
    recordPlayed(requestId);
  }

  const ctx = getAudioContext();
  if (!ctx) {
    return true;
  }

  try {
    await playTwoToneChime(ctx);
    return true;
  } catch {
    return false;
  }
}

export const playChime = playApprovalChime;

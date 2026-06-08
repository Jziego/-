const storeDraftKey = "ai-video-assistant:store-profile-draft";
const storeDraftStepKey = "ai-video-assistant:store-profile-step";
const storeDraftStepChangedEvent = "ai-video-assistant:store-profile-step-changed";

export function saveStoreDraft<T>(draft: T): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storeDraftKey, JSON.stringify(draft));
  } catch {
    // Ignore storage failures on mobile private mode or quota limits.
  }
}

export function loadStoreDraft<T>(): T | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storeDraftKey);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveStoreDraftStep(step: number): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storeDraftStepKey, String(step));
    window.dispatchEvent(new Event(storeDraftStepChangedEvent));
  } catch {
    // Ignore storage failures on mobile private mode or quota limits.
  }
}

export function loadStoreDraftStep(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storeDraftStepKey);
  if (!raw) return null;

  const step = Number(raw);
  return Number.isInteger(step) ? step : null;
}

export function clearStoreDraft(): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(storeDraftKey);
    window.localStorage.removeItem(storeDraftStepKey);
    window.dispatchEvent(new Event(storeDraftStepChangedEvent));
  } catch {
    // Ignore storage failures on mobile private mode or quota limits.
  }
}

export function subscribeStoreDraftStep(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  function handleStorage(event: StorageEvent): void {
    if (event.key === storeDraftStepKey) listener();
  }

  window.addEventListener(storeDraftStepChangedEvent, listener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(storeDraftStepChangedEvent, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

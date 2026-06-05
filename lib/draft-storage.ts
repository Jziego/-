const storeDraftKey = "ai-video-assistant:store-profile-draft";

export function saveStoreDraft<T>(draft: T): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storeDraftKey, JSON.stringify(draft));
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

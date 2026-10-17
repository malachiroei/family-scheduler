export type PwaInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
};

type PwaWindow = Window & { __pwaInstallPrompt?: PwaInstallPromptEvent | null };

const listeners = new Set<() => void>();

const win = () => (typeof window === "undefined" ? null : (window as PwaWindow));

export const getPwaInstallPrompt = (): PwaInstallPromptEvent | null => {
  const current = win();
  return current?.__pwaInstallPrompt ?? null;
};

export const clearPwaInstallPrompt = () => {
  const current = win();
  if (current) {
    current.__pwaInstallPrompt = null;
  }
  listeners.forEach((listener) => listener());
};

export const subscribePwaInstallPrompt = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const capturePrompt = (event: Event) => {
  event.preventDefault();
  const current = win();
  if (!current) {
    return;
  }
  current.__pwaInstallPrompt = event as PwaInstallPromptEvent;
  listeners.forEach((listener) => listener());
};

if (typeof window !== "undefined") {
  const current = window as PwaWindow & { __pwaInstallBound?: boolean };
  if (!current.__pwaInstallBound) {
    current.__pwaInstallBound = true;
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", () => {
      clearPwaInstallPrompt();
    });
  }
}

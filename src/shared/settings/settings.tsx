import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import {
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  useContext,
} from "solid-js";

export type SettingsValues = {
  theme: "system" | "light" | "dark";
  locale: "system" | "en" | "ko";
  notifications: { completion: boolean; permission: boolean };
};
export type SettingsPatch = Partial<Omit<SettingsValues, "notifications">> & {
  notifications?: Partial<SettingsValues["notifications"]>;
};
export type SettingsSnapshot = {
  values: SettingsValues;
  error: string | null;
  migrated: boolean;
};
const defaults = (): SettingsValues => ({
  theme: "system",
  locale: "system",
  notifications: { completion: true, permission: true },
});

export interface SettingsModel {
  values: () => SettingsValues;
  error: () => string | null;
  saving: () => boolean;
  update: (patch: SettingsPatch) => Promise<void>;
  retry: () => Promise<void>;
  dispose: () => void;
}

export function createMemorySettings(
  initial: SettingsPatch = {},
): SettingsModel {
  const [values, setValues] = createSignal<SettingsValues>({
    ...defaults(),
    ...initial,
    notifications: { ...defaults().notifications, ...initial.notifications },
  });
  return {
    values,
    error: () => null,
    saving: () => false,
    update: async (patch: SettingsPatch) => {
      setValues((current) => ({
        ...current,
        ...patch,
        notifications: { ...current.notifications, ...patch.notifications },
      }));
    },
    retry: async () => {},
    dispose: () => {},
  };
}

/** Connect before rendering the main screen; only snapshots publish settings. */
export async function initializeSettings(): Promise<SettingsModel> {
  if (!isTauri()) return createMemorySettings();
  const [values, setValues] = createSignal(defaults());
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  let subscription: string | undefined;
  let disposed = false;
  let attempt = 0;
  let activeWrites = 0;
  let revision = 0;

  async function connect() {
    const current = ++attempt;
    if (subscription) {
      await invoke("unsubscribe_thread", { subscription }).catch(() => {});
      subscription = undefined;
    }
    try {
      const legacy: {
        theme?: SettingsValues["theme"];
        locale?: SettingsValues["locale"];
      } = {};
      const theme = localStorage.getItem("atte.theme");
      const locale = localStorage.getItem("atte.locale");
      if (theme === "system" || theme === "light" || theme === "dark")
        legacy.theme = theme;
      if (locale === "system" || locale === "en" || locale === "ko")
        legacy.locale = locale;
      let firstSnapshot!: () => void;
      const initialSnapshot = new Promise<void>((resolve) => {
        firstSnapshot = resolve;
      });
      const channel = new Channel<SettingsSnapshot>();
      channel.onmessage = (snapshot) => {
        if (disposed || current !== attempt) return;
        ++revision;
        firstSnapshot();
        setValues(snapshot.values);
        setError(snapshot.error);
        if (snapshot.migrated) {
          try {
            localStorage.removeItem("atte.theme");
            localStorage.removeItem("atte.locale");
          } catch {
            // Retain old values if WebView storage cannot be cleaned up.
          }
        }
      };
      const token = await invoke<string>("subscribe_settings", {
        legacy,
        channel,
      });
      if (disposed || current !== attempt) {
        await invoke("unsubscribe_thread", { subscription: token }).catch(
          () => {},
        );
      } else {
        subscription = token;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            initialSnapshot,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Settings subscription did not provide an initial snapshot.",
                    ),
                  ),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (reason) {
      if (!disposed && current === attempt) setError(String(reason));
    }
  }
  await connect();
  return {
    values,
    error,
    saving,
    update: async (patch) => {
      if (error() || !subscription || disposed) return;
      const startedAt = revision;
      const generation = attempt;
      ++activeWrites;
      setSaving(true);
      try {
        await invoke<void>("update_settings", { patch });
      } catch (reason) {
        if (!disposed && generation === attempt && startedAt === revision)
          setError(String(reason));
      } finally {
        --activeWrites;
        if (!disposed) setSaving(activeWrites > 0);
      }
    },
    retry: connect,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ++attempt;
      if (subscription)
        void invoke("unsubscribe_thread", { subscription }).catch(() => {});
    },
  };
}

const SettingsContext = createContext<SettingsModel>();
export function SettingsProvider(props: {
  settings: SettingsModel;
  children: JSX.Element;
}) {
  onCleanup(() => props.settings.dispose());
  return (
    <SettingsContext.Provider value={props.settings}>
      {props.children}
    </SettingsContext.Provider>
  );
}
export function useSettings(): SettingsModel {
  return useContext(SettingsContext) ?? createMemorySettings();
}

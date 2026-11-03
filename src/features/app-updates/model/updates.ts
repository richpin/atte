import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { createSignal, onMount } from "solid-js";

type UpdateInfo = {
  supported: boolean;
  currentVersion: string;
  version: string | null;
  notes: string | null;
};
type Progress = { downloaded: number; total: number | null };

export function createAppUpdates() {
  const [info, setInfo] = createSignal<UpdateInfo>();
  const [busy, setBusy] = createSignal(false);
  const [installed, setInstalled] = createSignal(false);
  const [progress, setProgress] = createSignal<Progress>();
  const [error, setError] = createSignal(false);
  async function check() {
    if (!isTauri() || busy() || installed()) return;
    setBusy(true);
    setError(false);
    try {
      setInfo(await invoke<UpdateInfo>("check_app_update"));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    if (busy() || installed()) return;
    setBusy(true);
    setError(false);
    setProgress({ downloaded: 0, total: null });
    const channel = new Channel<Progress>();
    channel.onmessage = setProgress;
    try {
      await invoke("install_app_update", { progress: channel });
      setInstalled(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  }
  async function restart() {
    try {
      await invoke("restart_after_update");
    } catch {
      setError(true);
    }
  }
  onMount(() => void check());
  return { info, busy, installed, progress, error, check, install, restart };
}
export type AppUpdates = ReturnType<typeof createAppUpdates>;

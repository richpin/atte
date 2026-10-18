import { prepareFileTreeInput } from "@pierre/trees";

self.onmessage = (event: MessageEvent<{ id: number; paths: string[] }>) => {
  try {
    self.postMessage({
      id: event.data.id,
      prepared: prepareFileTreeInput(event.data.paths),
    });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: String(error) });
  }
};

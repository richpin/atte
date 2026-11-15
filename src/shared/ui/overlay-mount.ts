import { type Accessor, createContext } from "solid-js";

export const OverlayMountContext =
  createContext<Accessor<HTMLElement | undefined>>();

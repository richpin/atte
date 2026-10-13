import { createContext, type JSX, useContext } from "solid-js";

const WebLinkContext = createContext<(url: string) => void>();

export function WebLinkProvider(props: {
  onOpen: (url: string) => void;
  children: JSX.Element;
}) {
  return (
    <WebLinkContext.Provider value={(url) => props.onOpen(url)}>
      {props.children}
    </WebLinkContext.Provider>
  );
}

export function useWebLink() {
  return useContext(WebLinkContext);
}

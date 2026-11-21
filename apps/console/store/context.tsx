import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MediaRef } from "@contract";
import { DocumentDialog } from "@/media/document-dialog";
import type { ConsoleState, ConsoleStore } from "./store";

const StoreContext = createContext<ConsoleStore | null>(null);
type DocumentTile = { project: string; media: MediaRef };
const DocumentContext = createContext<((tile: DocumentTile) => void) | null>(null);

export function StoreProvider({ store, children }: { store: ConsoleStore; children: ReactNode }) {
  const [file, setFile] = useState<DocumentTile>();
  return (
    <StoreContext.Provider value={store}>
      <DocumentContext.Provider value={setFile}>
        {children}
        {file ? <DocumentDialog {...file} store={store} close={() => setFile(undefined)} /> : null}
      </DocumentContext.Provider>
    </StoreContext.Provider>
  );
}

/** Keeps the editor open when a decision card is replaced by a newer revision. */
export function useOpenDocument() {
  const open = useContext(DocumentContext);
  if (!open) throw new Error("useOpenDocument outside StoreProvider");
  return open;
}

/** The store, or null outside a StoreProvider (a media component rendered on its own). */
export function useOptionalConsoleStore(): ConsoleStore | null {
  return useContext(StoreContext);
}

export function useConsoleStore(): ConsoleStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useConsoleStore outside StoreProvider");
  return store;
}

/** Reads a slice of the store; the selector must return a value already in the state (no new objects). */
export function useConsole<T>(selector: (state: ConsoleState) => T): T {
  const store = useConsoleStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

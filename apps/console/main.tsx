import { ZOD_CONFIG } from "./lib/zod-jitless";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boot } from "./boot";

const store = boot();
const root = document.getElementById("root");
if (root && ZOD_CONFIG.jitless)
  createRoot(root).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const rootNode = document.getElementById("root");

if (!rootNode) {
  throw new Error("Lightcode could not find its application root.");
}

createRoot(rootNode).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

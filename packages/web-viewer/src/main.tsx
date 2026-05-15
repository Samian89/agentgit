import React from "react";
import { createRoot } from "react-dom/client";
import "@agentgit/ui-components/styles.css";
import App from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

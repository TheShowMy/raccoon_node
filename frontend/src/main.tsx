import React from "react";
import ReactDOM from "react-dom/client";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/index.css";
// Theme CSS is loaded centrally via theme/astryxThemes.ts so the cached theme
// can be applied synchronously on first render without a neutral flash.
import "./theme/astryxThemes";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

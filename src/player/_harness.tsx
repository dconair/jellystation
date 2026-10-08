// Temporärer Prüfstand (wird nach den Tests gelöscht).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import "../index.css";
import { Player } from "./Player";

declare global {
  interface Window {
    __mount: (cfg: any) => void;
    __unmount: () => void;
    __closes: any[];
  }
}
window.__closes = [];
let root: Root | null = null;
window.__mount = (cfg) => {
  window.__unmount();
  const el = document.getElementById("root")!;
  root = createRoot(el);
  const node = (
    <Player
      entry={cfg.entry}
      jellyfin={cfg.jellyfin ?? null}
      startSec={cfg.startSec}
      playlist={cfg.playlist}
      onClose={(info) => {
        window.__closes.push(info);
        if (cfg.unmountOnClose !== false) window.__unmount();
      }}
    />
  );
  root.render(cfg.strict ? <StrictMode>{node}</StrictMode> : node);
};
window.__unmount = () => {
  root?.unmount();
  root = null;
};

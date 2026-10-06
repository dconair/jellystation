import { isTauri } from "../platform";

/** Schaltet Vollbild um – nativ in Tauri, sonst über die Fullscreen-API des Browsers. */
export async function toggleFullscreen() {
  try {
    if (isTauri()) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.setFullscreen(!(await win.isFullscreen()));
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.warn("Vollbild konnte nicht umgeschaltet werden", err);
  }
}

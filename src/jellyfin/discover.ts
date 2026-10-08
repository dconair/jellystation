import { isTauri } from "../platform";

export interface FoundServer {
  address: string;
  id: string;
  name: string;
}

/** Sucht Jellyfin-Server im lokalen Netz (UDP-Broadcast, Rust-Befehl jellyfin_discover). Im Browser: leer. */
export async function discoverServers(waitMs = 1500): Promise<FoundServer[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<FoundServer[]>("jellyfin_discover", { waitMs });
}

import { fetchAccountAddons } from "./account";
import { fetchManifest } from "./api";
import type { StremioSettings } from "./types";

export interface StremioCheck {
  status: "ok" | "warn" | "fail";
  message: string;
}

const plural = (n: number) => `${n} Addon${n === 1 ? "" : "s"}`;

/**
 * Prüft Stremio, ohne etwas zu ändern: Ist der Anmeldeschlüssel des Kontos noch gültig, und antwortet jedes von Hand
 * eingetragene Addon mit einem Manifest? (Addons aus dem Konto kommen mit der Kontoabfrage mit.)
 */
export async function checkStremio(stremio: StremioSettings | undefined, signal?: AbortSignal): Promise<StremioCheck> {
  const account = stremio?.account;
  const manual = (stremio?.addons ?? []).filter((a) => !a.fromAccount);
  if (!account && manual.length === 0) return { status: "warn", message: "Nicht eingerichtet" };

  const parts: string[] = [];
  let status: StremioCheck["status"] = "ok";
  if (account) {
    try {
      const list = await fetchAccountAddons(account.authKey, signal);
      parts.push(`Konto verbunden: ${plural(list.length)} geladen`);
    } catch (err) {
      if (signal?.aborted) throw err;
      status = "fail";
      parts.push(err instanceof Error ? err.message : "Konto nicht erreichbar");
    }
  }
  if (manual.length) {
    const results = await Promise.allSettled(manual.map((a) => fetchManifest(a.url, signal)));
    if (signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
    const failed = manual.filter((_, i) => results[i].status === "rejected");
    if (failed.length === 0) parts.push(`${plural(manual.length)} erreichbar`);
    else {
      if (status === "ok") status = "warn";
      const first = results[manual.indexOf(failed[0])] as PromiseRejectedResult;
      const why = first.reason instanceof Error ? first.reason.message : "nicht erreichbar";
      parts.push(`${failed.map((a) => a.name).join(", ")}: ${why}`);
    }
  }
  return { status, message: parts.join(" · ") };
}

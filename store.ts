import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HubStore, DeviceSubmission, TokenContributionData } from "./types.ts";

const STORE_PATH = process.env.HUB_STORE_PATH ?? "./hub-store.json";

function emptyStore(): HubStore {
  return { submissions: {}, lastPushedAt: null };
}

export function loadStore(): HubStore {
  if (!existsSync(STORE_PATH)) return emptyStore();
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as HubStore;
  } catch {
    console.error("[store] Failed to parse store file — starting fresh");
    return emptyStore();
  }
}

export function saveStore(store: HubStore): void {
  const dir = dirname(STORE_PATH);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function upsertSubmission(
  store: HubStore,
  deviceId: string,
  data: TokenContributionData
): void {
  store.submissions[deviceId] = {
    deviceId,
    receivedAt: new Date().toISOString(),
    data,
  };
}

export function listSubmissions(store: HubStore): DeviceSubmission[] {
  return Object.values(store.submissions);
}

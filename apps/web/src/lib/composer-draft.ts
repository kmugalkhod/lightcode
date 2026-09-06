import { z } from "zod";
import type { StorageLike } from "./api";

const draftSchema = z.string().max(100_000);
const prefix = "lightcode.web.draft.";

export function readComposerDraft(key: string, storage?: StorageLike): string {
  try {
    return draftSchema.parse(JSON.parse((storage ?? sessionStorage).getItem(prefix + key) ?? '""'));
  } catch { return ""; }
}

export function saveComposerDraft(key: string, value: string, storage?: StorageLike): void {
  try {
    const target = storage ?? sessionStorage;
    if (value) target.setItem(prefix + key, JSON.stringify(draftSchema.parse(value)));
    else target.removeItem(prefix + key);
  } catch { /* Editing remains available when storage is full or disabled. */ }
}

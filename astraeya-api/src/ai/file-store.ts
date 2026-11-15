import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

/**
 * The provider's file store, where files made in the code sandbox live.
 * Only the server talks to it; users get Astraeya's signed links instead.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export function fileStoreAvailable(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/** The file's bytes, as a fetch Response whose body can be streamed on. */
export async function openStoredFile(providerFileId: string): Promise<Response> {
  return getClient().files.download(providerFileId);
}

/** Best effort: a file already gone is not an error. */
/** True once the stored copy is gone (already missing counts as gone). */
export async function deleteStoredFile(providerFileId: string): Promise<boolean> {
  try {
    await getClient().files.delete(providerFileId);
    return true;
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError) return true;
    console.error("Could not delete a stored file:", err instanceof Error ? err.message : err);
    return false;
  }
}

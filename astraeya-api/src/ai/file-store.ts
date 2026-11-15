import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { env } from "../env";
import { db, schema } from "../db";

/** Files kept in Astraeya's own database rather than the provider's store. */
const DB_PREFIX = "db:";

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
  if (providerFileId.startsWith(DB_PREFIX)) {
    const row = await db.query.storedBlobs.findFirst({
      where: eq(schema.storedBlobs.id, providerFileId.slice(DB_PREFIX.length)),
    });
    if (!row) throw new Error("stored file not found");
    return new Response(new Uint8Array(row.bytes), {
      headers: { "content-type": row.mediaType, "content-length": String(row.sizeBytes) },
    });
  }
  return getClient().files.download(providerFileId);
}

/**
 * Keeps bytes made outside the sandbox (a generated image or video) in the
 * same store, so they get the same signed links, retention and deletion as
 * every other made file.
 */
export async function putStoredFile(
  bytes: Buffer,
  _filename: string,
  mediaType: string
): Promise<{ providerFileId: string; sizeBytes: number }> {
  // The provider's store will not serve uploaded files back, so made media
  // is kept here. Swapping this for object storage changes nothing else.
  const [row] = await db
    .insert(schema.storedBlobs)
    .values({ mediaType, sizeBytes: bytes.length, bytes })
    .returning({ id: schema.storedBlobs.id });
  return { providerFileId: DB_PREFIX + row.id, sizeBytes: bytes.length };
}

/** True once the stored copy is gone (already missing counts as gone). */
export async function deleteStoredFile(providerFileId: string): Promise<boolean> {
  if (providerFileId.startsWith(DB_PREFIX)) {
    await db.delete(schema.storedBlobs).where(eq(schema.storedBlobs.id, providerFileId.slice(DB_PREFIX.length)));
    return true;
  }
  try {
    await getClient().files.delete(providerFileId);
    return true;
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError) return true;
    console.error("Could not delete a stored file:", err instanceof Error ? err.message : err);
    return false;
  }
}

import { readFile } from "node:fs/promises";

const SOUND_URLS: Record<string, URL> = {
  bright: new URL("../assets/notification-sounds/bright.wav", import.meta.url),
  calm: new URL("../assets/notification-sounds/calm.wav", import.meta.url),
  playful: new URL("../assets/notification-sounds/playful.wav", import.meta.url),
};

/** Serve the three bundled UI sounds through the host's existing Kit API route. */
export async function serveNotificationSound(name: string): Promise<Response> {
  const url = Object.hasOwn(SOUND_URLS, name) ? SOUND_URLS[name] : undefined;
  if (!url) return new Response(null, { status: 404 });
  try {
    const bytes = await readFile(url);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

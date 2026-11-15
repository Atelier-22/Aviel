/**
 * Web app manifest, so the 192 and 512 icons are used when Astraeya is installed
 * to a home screen rather than only appearing in the browser tab.
 *
 * Served from a route handler rather than a static file so the icon paths stay
 * next to the metadata that references them in layout.tsx.
 */
export function GET() {
  return Response.json(
    {
      name: "Astraeya",
      short_name: "Astraeya",
      description: "Astraeya — Built in Uganda. Designed for the world.",
      start_url: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#1e6bff",
      icons: [
        {
          src: "/brand/icon-192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/brand/icon-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/brand/icon-maskable-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json" } }
  );
}

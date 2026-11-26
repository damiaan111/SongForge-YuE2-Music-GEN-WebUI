import type { NextConfig } from "next";

// The backend listens on localhost only. The web app is the only part that
// can be reached from the network (and only when started with -Lan / --lan);
// it proxies /api to the backend, so the API is never directly exposed.
const API_URL = process.env.SONGFORGE_API_URL ?? "http://127.0.0.1:3334";

// Sent with every page. None of these replace the checks in the backend
// (songforge/security.py); they close the browser-side doors beside them.
const SECURITY_HEADERS = [
  // Another site must not be able to draw this app inside a frame and trick
  // someone into clicking "Delete permanently" through it.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // Downloads are served with their real type; the browser must not guess.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Links out of the app (the Learn page's sources) must not carry the
  // address of the page they were clicked on, which names the song.
  { key: "Referrer-Policy", value: "no-referrer" },
  // The app uses none of these, so nothing embedded in it may either.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not announce the framework and its version to whoever asks.
  poweredByHeader: false,
  experimental: {
    // The proxy to the backend gives up on a request that is quiet for 30
    // seconds by default. Verifying 7 GB of weights in the self-test, or
    // exporting a large library, can be quiet for longer than that on a slow
    // disk; ten minutes is beyond anything the app legitimately waits for.
    proxyTimeout: 10 * 60 * 1000,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

// The backend listens on localhost only. The frontend is what binds to the LAN
// and proxies /api to it, so the API is never directly exposed on the network.
const API_URL = process.env.SONGFORGE_API_URL ?? "http://127.0.0.1:3334";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;

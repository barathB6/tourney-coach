import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/coach',
        destination: '/coach/index.html',
      },
    ];
  },
};

export default nextConfig;

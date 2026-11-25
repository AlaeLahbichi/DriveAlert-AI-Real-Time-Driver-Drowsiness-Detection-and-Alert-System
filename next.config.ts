import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Autorise l'ouverture en dev depuis l'IP du Mac sur le réseau local (téléphone, autre PC).
  allowedDevOrigins: ["192.168.1.3"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

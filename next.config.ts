import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", "100.79.184.36"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { typedEnv: true },
  serverExternalPackages: ["@harnestai/sdk", "@harnestai/protocol"],
  turbopack: { root: resolve(process.cwd(), "..") },
};

export default nextConfig;

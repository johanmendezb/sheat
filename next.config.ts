import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Do not let `next dev` write an AGENTS.md file into the project.
  agentRules: false,
  // Allow opening the dev server from a phone on the local network or a temporary tunnel.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "*.trycloudflare.com"],
};

export default nextConfig;

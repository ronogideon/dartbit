/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: false,
  // Only pull the icons/chart primitives actually used, instead of the whole barrel — trims the
  // initial bundle and main-thread parse cost.
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts'],
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'https://dartbit-production.up.railway.app',
  },
};

module.exports = nextConfig;

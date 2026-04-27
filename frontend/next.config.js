/** @type {import('next').NextConfig} */
const nextConfig = {
<<<<<<< HEAD
  output: 'standalone',
  reactStrictMode: false,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'https://dartbit-production.up.railway.app',
=======
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
>>>>>>> aec8eb59fae5ddb9c2b5bdbd861d15f5e7b7c253
  },
};

module.exports = nextConfig;

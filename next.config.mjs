/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
  experimental: {
    // turbo is enabled by default in 'next dev --turbo'
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
  experimental: {
    // Keep static-export builds within the repository's CI memory budget.
    cpus: 1,
  },
};

export default nextConfig;

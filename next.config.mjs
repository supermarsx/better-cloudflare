/** @type {import('next').NextConfig} */
const githubPagesBasePath = process.env.GITHUB_PAGES_BASE_PATH?.trim() ?? "";
const isGitHubPages = githubPagesBasePath.length > 0;
const basePath = isGitHubPages ? `/${githubPagesBasePath}` : undefined;
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  basePath,
  assetPrefix: isGitHubPages ? `${basePath}/` : undefined,
  reactStrictMode: true,
  experimental: {
    // turbo is enabled by default in 'next dev --turbo'
  },
};

export default nextConfig;

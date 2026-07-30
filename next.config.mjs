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
    // Keep static-export builds within the repository's CI memory budget.
    cpus: 1,
  },
};

export default nextConfig;

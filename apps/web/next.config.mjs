/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@smartvest/shared-types', '@smartvest/domain'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;

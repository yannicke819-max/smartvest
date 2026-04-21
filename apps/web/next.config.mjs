/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@smartvest/shared-types', '@smartvest/domain', '@smartvest/portfolio-engine'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;

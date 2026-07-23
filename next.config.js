/** @type {import('next').NextConfig} */

const nextConfig = {
  // ============================================
  // CORE CONFIG
  // ============================================
  
  reactStrictMode: true,
  outputFileTracingRoot: typeof __dirname !== 'undefined' ? __dirname : undefined,
  compress: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  
  // ============================================
  // COMPILER OPTIMIZATIONS
  // ============================================
  
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn'],
    } : false,
  },
  
  // ============================================
  // IMAGE OPTIMIZATION
  // ============================================
  
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'skilldrills.online' },
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
  
  // ============================================
  // EXPERIMENTAL (Next.js 15 compatible)
  // ============================================
  
  experimental: {
    optimizeCss: false,
    optimizePackageImports: [
      'lucide-react',
    ],
  },
  
  // ============================================
  // WEBPACK SPLIT CHUNKS (Reduces TBT)
  // ============================================
  
  webpack: (config, { isServer, dev }) => {
    return config;
  },
  
  eslint: {
    ignoreDuringBuilds: true,
  },

  typescript: {
    ignoreBuildErrors: true,
  },

  // ============================================
  // OUTPUT
  // ============================================
  
  output: 'export',
  trailingSlash: true,
  // outputFileTracingRoot only needed for standalone mode
};

module.exports = nextConfig;
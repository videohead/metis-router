/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    swcMinify: true,
    output: 'standalone',
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
    experimental: {
        outputFileTracingRoot: undefined,
    },
}

module.exports = nextConfig
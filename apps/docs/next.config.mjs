import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

export default withMDX({
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/",
        destination: "/en",
        permanent: false,
      },
    ];
  },
});

const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function (eleventyConfig) {
  // Copy static assets straight through to /assets
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // ISO date for sitemap lastmod
  eleventyConfig.addFilter("isoDate", (d) => new Date(d).toISOString());

  // Dev-only same-origin proxy: forward /api/* to the Fastify API (:3000) with the
  // /api prefix stripped, so the session cookie is same-origin (no CORS). In prod a
  // reverse proxy (nginx/Caddy) serves _site + routes /api to the API.
  eleventyConfig.setServerOptions({
    middleware: [
      createProxyMiddleware({
        pathFilter: "/api",
        target: "http://localhost:3000",
        changeOrigin: true,
        pathRewrite: { "^/api": "" },
      }),
    ],
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      output: "_site",
    },
    // Author pages in plain HTML, processed through Nunjucks for layouts/includes.
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
    // Pretty permalinks (projets.html -> /projets/) are Eleventy's default.
  };
};

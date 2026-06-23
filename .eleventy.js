module.exports = function (eleventyConfig) {
  // Copy static assets straight through to /assets
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // ISO date for sitemap lastmod
  eleventyConfig.addFilter("isoDate", (d) => new Date(d).toISOString());

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

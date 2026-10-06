import fs from 'node:fs';

export default function (eleventyConfig) {
  // docs/ is generated; start each build from an empty folder so removed pages do not linger.
  eleventyConfig.on('eleventy.before', ({ directories, runMode }) => {
    if (runMode === 'build') fs.rmSync(directories.output, { recursive: true, force: true });
  });

  eleventyConfig.addPassthroughCopy('src/.nojekyll');
  eleventyConfig.addPassthroughCopy('src/style.css');
  eleventyConfig.addPassthroughCopy('src/main.js');
  eleventyConfig.addPassthroughCopy('src/sketches');

  // Turn a site path ("/style.css") into a path relative to the current page,
  // so the site works under any base URL.
  eleventyConfig.addFilter('rel', (target, pageUrl) => {
    const depth = pageUrl.split('/').filter(Boolean).length;
    const path = target.replace(/^\//, '');
    return ('../'.repeat(depth) || './') + path;
  });

  return {
    dir: {
      input: 'src',
      output: 'docs'
    },
    // Notice posts are pasted HTML (X embeds); do not run them through a template engine.
    htmlTemplateEngine: false
  };
}

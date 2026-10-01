// Heading ids as GitHub makes them (github-slugger), so that a link such as
// `errors.md#what-to-do-about-each-error` lands on the same heading on github.com and on the
// site. The site's Markdown uses it for every heading, and test/docs/links.test.ts uses it to
// check every `#anchor`. Repeats of a heading get -1, -2 … from the anchor plugin, as on GitHub.

/** The id GitHub gives a heading with this text. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/ /g, '-');
}

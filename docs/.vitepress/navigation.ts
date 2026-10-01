// The site's navigation, as data: the sidebar's sections and the order of their pages, and the
// learning path that runs through three of them. Pages are paths under docs/; each one's title
// in the sidebar is the `title` of its front matter. config.mts turns this into the sidebar and
// the lessons' step headers and pagers; test/docs/front-matter.test.ts checks that every page
// is listed once and that every listed page exists.

/** A sidebar section: its landing page, and its pages (or subsections) in reading order. */
export interface Section {
  readonly index: string;
  readonly pages: readonly (string | Section)[];
}

/** One part of a guided journey: a name, and its sections' pages are its steps. */
export interface Part {
  readonly name: string;
  readonly section: Section;
}

/** A guided journey: steps read in order, part by part, then a page to go on to. */
export interface Journey {
  readonly name: string;
  readonly unit: string;
  readonly parts: readonly Part[];
  readonly finish: string;
}

const start: Section = {
  index: 'start/index.md',
  pages: ['start/quick-start.md', 'start/mental-model.md', 'start/tutorial.md'],
};

const foundations: Section = {
  index: 'learn/foundations/index.md',
  pages: [
    'learn/foundations/ledgers.md',
    'learn/foundations/cryptography.md',
    'learn/foundations/wallets.md',
    'learn/foundations/assets.md',
    'learn/foundations/transactions.md',
    'learn/foundations/blocks.md',
    'learn/foundations/ordering.md',
    'learn/foundations/fees.md',
    'learn/foundations/nodes.md',
  ],
};

const engineering: Section = {
  index: 'learn/engineering/index.md',
  pages: [
    'learn/engineering/failure.md',
    'learn/engineering/idempotency.md',
    'learn/engineering/persistence.md',
    'learn/engineering/concurrency.md',
    'learn/engineering/trust.md',
    'learn/engineering/secrets.md',
  ],
};

const tour: Section = {
  index: 'tour/index.md',
  pages: [
    'tour/architecture.md',
    'tour/families.md',
    'tour/transfer.md',
    'tour/recovery.md',
    'tour/ordering.md',
    'tour/evidence.md',
    'tour/receiving.md',
    'tour/keys.md',
    'tour/production.md',
  ],
};

const build: Section = {
  index: 'build/index.md',
  pages: [
    'build/examples.md',
    'build/connect.md',
    'build/send.md',
    'build/confirmations.md',
    'build/stalled.md',
    'build/cold-signing.md',
    'build/receive.md',
    'build/workers.md',
    'build/keys.md',
    'build/testing.md',
    'build/production.md',
  ],
};

const networks: Section = {
  index: 'reference/networks/index.md',
  pages: [
    'reference/networks/evm.md',
    'reference/networks/bitcoin.md',
    'reference/networks/tron.md',
    'reference/networks/solana.md',
    'reference/networks/ton.md',
    'reference/networks/avalanche.md',
  ],
};

const reference: Section = {
  index: 'reference/index.md',
  pages: [
    'reference/api.md',
    'reference/configuration.md',
    'reference/concepts.md',
    'reference/errors.md',
    'reference/capabilities.md',
    networks,
    'reference/glossary.md',
    'reference/stability.md',
  ],
};

const explore: Section = {
  index: 'explore/index.md',
  pages: [
    'explore/source-map.md',
    'explore/custom-networks.md',
    'explore/plugins.md',
    'explore/stores.md',
    'explore/design-records.md',
  ],
};

/** The sidebar, top to bottom. The home page and the moved pages of guides/ are not in it. */
export const SIDEBAR: readonly Section[] = [
  start,
  { index: 'learn/index.md', pages: [foundations, engineering] },
  tour,
  build,
  reference,
  explore,
];

/** The learning path: blockchain foundations, the engineering of payments, the tour. */
export const LEARNING_PATH: Journey = {
  name: 'The learning path',
  unit: 'Step',
  parts: [
    { name: 'Part 1 · Blockchain foundations', section: foundations },
    { name: 'Part 2 · Engineering for money', section: engineering },
    { name: 'Part 3 · Developer tour', section: tour },
  ],
  finish: 'start/tutorial.md',
};

/** Every page a section lists, its landing page first, subsections included. */
export function sectionPages(section: Section): string[] {
  return [
    section.index,
    ...section.pages.flatMap((page) =>
      typeof page === 'string' ? [page] : sectionPages(page),
    ),
  ];
}

/** A journey's steps in reading order: each part's pages, without its landing page. */
export function journeySteps(journey: Journey): { part: string; path: string }[] {
  return journey.parts.flatMap(({ name, section }) =>
    section.pages.map((page) => {
      if (typeof page !== 'string') throw new Error(`${name} holds a subsection`);
      return { part: name, path: page };
    }),
  );
}

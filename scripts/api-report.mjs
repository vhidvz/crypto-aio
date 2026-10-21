// The public API, as API Extractor reports it: one report per entry point of package.json's
// `exports`, in `etc/api/`. Run `pnpm build` first.
//
// `node scripts/api-report.mjs` fails when an entry point's API differs from its committed
// report, so CI catches every change to the public API. `--update` rewrites the reports;
// commit them with the change, and the diff of `etc/api/` shows reviewers exactly what the
// change does to the API: a removed or changed line there is a breaking change.
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const update = process.argv.includes('--update');
const reports = join(root, 'etc', 'api');
mkdirSync(reports, { recursive: true });

const entries = Object.entries(pkg.exports)
  .filter(([key]) => key !== './package.json')
  .map(([key, target]) => ({
    name: key === '.' ? 'crypto-aio' : `crypto-aio-${key.slice(2)}`,
    types: join(root, target.types),
  }));

let failed = false;
for (const { name, types } of entries) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: types,
      compiler: { tsconfigFilePath: join(root, 'tsconfig.build.json') },
      apiReport: {
        enabled: true,
        reportFileName: `${name}.api.md`,
        reportFolder: reports,
        reportTempFolder: join(root, 'node_modules', '.cache', 'api-extractor'),
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: 'warning' } },
        extractorMessageReporting: {
          default: { logLevel: 'warning' },
          // Types reachable from the API but exported under another entry point, or by
          // structure only, are reported inline; they are not missing.
          'ae-forgotten-export': { logLevel: 'none' },
          'ae-missing-release-tag': { logLevel: 'none' },
          'ae-unresolved-link': { logLevel: 'none' },
          'ae-undocumented': { logLevel: 'none' },
        },
        tsdocMessageReporting: { default: { logLevel: 'none' } },
      },
    },
    configObjectFullPath: join(root, 'api-extractor.json'),
    packageJsonFullPath: join(root, 'package.json'),
  });
  const result = Extractor.invoke(config, {
    localBuild: update,
    showVerboseMessages: false,
  });
  if (!result.succeeded) {
    failed = true;
    console.error(
      `${name}: the API differs from etc/api/${name}.api.md` +
        (update ? '' : '; run `pnpm api:update` and commit the report if it is intended'),
    );
  } else if (result.apiReportChanged) {
    console.log(`${name}: report updated`);
  }
}
if (failed) process.exit(1);
console.log(
  `api: ${entries.length} entry points ${update ? 'reported' : 'match their reports'}`,
);

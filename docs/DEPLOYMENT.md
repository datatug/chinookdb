# Deployment

chinookdb.com deploys itself: `.github/workflows/deploy.yml` checks, builds and publishes the Worker, so nobody runs `wrangler deploy` by hand.

| Trigger | What runs |
|---|---|
| push to `main` | the checks of `ci.yml`, the build, the build marker, `pnpm exec wrangler deploy`, then a smoke check |
| manual run (Actions, "Deploy", on `main`; any other ref runs the checks only and cannot deploy) | the same |
| pull request | the checks, the build and the build marker; never a deploy, never in a fork |

There is no timer: chinookdb.com is built from this repository alone, with no external index, so a deploy is due exactly when `main` changes (a push), or when someone runs the workflow.

Runs that can deploy share one concurrency group (one deploy at a time, a queued run is replaced by a newer one that builds the newer `main`); a pull request run, or a manual run on another ref, has a group of its own and so can never replace a pending run on `main`. `ci.yml` keeps running beside the deploy workflow; `deploy.yml` repeats every step of it (`tools:install`, `build`, `validate`, `test:data`, `test:model`, `check:ovdb`, the check that `model/` is committed, `lint:model`, `check:model-twin`, `check:meaning`, `check:schema`, `check:drift`, `test:worker`, `test:tools`, with the same checkout, pnpm, node and cache setup; `tools:install` puts the pinned `modelspec` and `meaninggraph` releases in `.tools/bin` after checking the SHA-256 of each archive against `scripts/tools.json`) so that a deploy waits for them. `scripts/test-deploy.mjs` fails when `ci.yml` has a step that `deploy.yml` lacks, whatever its command, or has it in another order, with another environment or condition, with `continue-on-error`, or after the deploy: a check added to one must be added to the other. The actions in both workflows are pinned by full commit SHA (the deploy job holds the Cloudflare token), and every job has a timeout; `scripts/test-tools.mjs` checks that for both.

**The build marker.** After the checks, `scripts/write-build-info.mjs` writes `dist/build-info.json` (`{"format": "chinookdb-build/1", "commit": "<40-digit commit>"}`, the commit from `BUILD_COMMIT`, set by the workflow), served at `https://chinookdb.com/build-info.json`. After the deploy, `scripts/smoke-live.mjs` fetches the live marker again and the pages `/` and `/downloads/`, each retried with growing waits (5 to 30 seconds, about two and a half minutes in all) while the new version spreads, and fails the run red unless the marker names the commit just deployed and the pages answer 200. Marker values are shape-checked before they are printed.

**There is no automatic rollback.** A red smoke check, or a deploy that fails part-way, leaves whatever Cloudflare has made live, live. To go back by hand: `pnpm exec wrangler rollback` (it makes the previously deployed version of the `chinookdb` Worker the active deployment at once; `pnpm exec wrangler rollback <VERSION_ID>` picks another of the last 100 versions, and `pnpm exec wrangler deployments list --name chinookdb` shows them), or revert the commit and push, which redeploys. Cloudflare documents rollback for Workers versions; it has not been tried on this Worker with static assets, so check the live site afterwards.

**A red run on `main` is not retried.** With a push as the only automatic trigger, a transient failure (the pinned `meaninggraph/core` checkout that `pnpm test:model` fetches, the release downloads in `pnpm tools:install`, a Cloudflare API error) leaves that commit undeployed until someone runs "Deploy" again from the Actions tab.

**Credentials.** The deploy needs the `CLOUDFLARE_API_TOKEN` secret and the `CLOUDFLARE_ACCOUNT_ID` variable (an identifier, not a secret) on this repository, or on the `datatug` organisation shared with it. When either is missing the workflow still runs the checks and the build, skips the deploy and the smoke check with a notice (a `::notice::` and a line in the job summary) and ends green. The token is in the environment of one step, "Deploy", which runs `pnpm exec wrangler deploy --config wrangler.jsonc` and nothing else (`wrangler.jsonc` has no build command, so the only code that runs with the token is wrangler bundling `src/worker.ts`). It needs edit rights on the Worker and on the zone of the custom domain in `wrangler.jsonc`: a token without DNS rights can upload the Worker and still fail at the domain step. Cloudflare's documentation says `wrangler deploy` changes routes and custom domains as part of the deployment but not in what order it uploads the version and updates them, so after such a failure the run is red, the smoke check is skipped, and whether the new version is already live is not documented: look at `https://chinookdb.com/build-info.json` and use the rollback above if you want the previous version back. The account id is not masked in this public repository's logs, and wrangler error messages can include it; it is an identifier, not a credential, so keep it as a secret only if it should not be public.

**Deploying by hand in an emergency.** From a clean checkout of `main`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in your shell:

```sh
pnpm install --frozen-lockfile
pnpm build
BUILD_COMMIT=$(git rev-parse HEAD) node scripts/write-build-info.mjs   # so the live site names the commit (optional)
pnpm exec wrangler deploy --config wrangler.jsonc
pnpm exec wrangler deployments list --name chinookdb --json
```

Or run the "Deploy" workflow from the Actions tab. Without the `write-build-info.mjs` line, `dist/` holds no `build-info.json`, so the deployed site would not serve one and `/build-info.json` would answer 404 until the next workflow deploy.

# Deployment

chinookdb.com deploys itself: `.github/workflows/deploy.yml` checks, builds and publishes the Worker, so nobody runs `wrangler deploy` by hand.

| Trigger | What runs |
|---|---|
| push to `main` | the checks of `ci.yml`, the build, the build marker, `pnpm exec wrangler deploy`, then a smoke check |
| manual run (Actions, "Deploy", on `main`) | the same |
| pull request | the checks, the build and the build marker; never a deploy, never in a fork |

There is no scheduled run: chinookdb.com is built from this repository alone, with no external index, so a deploy is due exactly when `main` changes.

Runs are serialised (one concurrency group). `ci.yml` keeps running beside the deploy workflow; the deploy workflow repeats its checks (`pnpm build`, `validate`, `test:data`, `test:model`, `check:ovdb`, the check that `model/` is committed, `lint:modelspec`, `check:drift`, `test:worker`) so that a deploy waits for them. `scripts/test-deploy.mjs` fails when `ci.yml` runs a `pnpm` command that `deploy.yml` does not, so a check added to one is added to the other.

**The build marker.** After the checks, `scripts/write-build-info.mjs` writes `dist/build-info.json` (`{"format": "chinookdb-build/1", "commit": "<40-digit commit>"}`, the commit from `BUILD_COMMIT`, set by the workflow), served at `https://chinookdb.com/build-info.json`. After the deploy, `scripts/smoke-live.mjs` fetches the live marker again, retrying for about a minute while the new version spreads, and fails unless it records the commit just deployed; it also checks that `/` and `/downloads/` answer 200.

**Credentials.** The deploy needs the `CLOUDFLARE_API_TOKEN` secret and the `CLOUDFLARE_ACCOUNT_ID` variable (an identifier, not a secret) on this repository, or on the `datatug` organisation shared with it. When either is missing the workflow still runs the checks and the build, skips the deploy and the smoke check with a notice (a `::notice::` and a line in the job summary) and ends green. The token is only ever passed to the deploy step's environment. It needs edit rights on the Worker and on the zone of the custom domain in `wrangler.jsonc`: a token without DNS rights can upload the Worker and still fail at the domain step, although the domain is already attached.

**Deploying by hand in an emergency.** From a clean checkout of `main`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in your shell:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec wrangler deploy --config wrangler.jsonc
pnpm exec wrangler deployments list --name chinookdb --json
```

Or run the "Deploy" workflow from the Actions tab. A manual deploy leaves no `build-info.json` in `dist/`, so the live marker keeps naming the previous commit until the next workflow deploy.

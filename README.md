# conductor-idea

An **IDEA Crosswalk** feature for [LibreTexts Conductor](https://github.com/libretexts/conductor):
faculty capture a chapter of an open textbook, assess it against the ASCCC OERI
*Inclusion, Diversity, Equity, and Anti-Racism (IDEA) Framework*, ask an AI model for evidence-cited
drafts per framework category, record their own judgments and revision plan, compare chapters in a
synthesis, and export the whole record.

This repository is the integration package. It contains the feature's source files at their
Conductor paths, a small patch for the six existing Conductor files it touches, and the pieces that
made the libretexts.dev proof-of-concept run without LibreTexts credentials. It is not a fork.

```
overlay/    89 files to copy into a Conductor checkout (all additive)
patches/    conductor-integration.patch — 27 lines across 6 existing files
demo/       mirror indexer, Caddy rewrites, compose lines (proof-of-concept only)
LICENSE     MIT
NOTICE      third-party attributions (vendored framework module, OERI text)
```

Everything described here was built and run on the libretexts.dev proof-of-concept deployment
(Conductor fork `johnnylibretexts/conductor-dev`, September 2026). Sections marked **demo** describe
that deployment; sections marked **production** describe what a LibreTexts deployment does instead.

---

## Contents

1. [What the feature does](#1-what-the-feature-does)
2. [How it works](#2-how-it-works)
3. [Applying it to Conductor](#3-applying-it-to-conductor)
4. [Configuration](#4-configuration)
5. [Running it](#5-running-it)
6. [Operating it](#6-operating-it)
7. [Tests and CI](#7-tests-and-ci)
8. [The proof-of-concept mirror (demo only)](#8-the-proof-of-concept-mirror-demo-only)
9. [What was verified](#9-what-was-verified)
10. [Known limits and open work](#10-known-limits-and-open-work)
11. [File map](#11-file-map)

---

## 1. What the feature does

A project in Conductor is linked to a book (`libreLibrary` + `libreCoverID`). With IDEA enabled for
that project, a project lead or member can:

1. **Capture** a chapter. Conductor discovers the book's public page tree through the library API,
   the faculty member picks a chapter root and the pages to include (up to 25, plus up to 5
   supplements from elsewhere in the book), and the server fetches each page's HTML anonymously,
   normalises it into ordered text blocks (`pageID:ordinal`), and stores an immutable **snapshot**
   with a content hash. Excluded pages are recorded, never silently dropped.
2. **Review** the snapshot. A review record holds the ten rubric rows of the framework
   (`7.1.a` … `7.8.a`), a checklist, notes, summary, suggestions and a revision plan. Reviews are
   versioned; every save is an immutable revision and the history is exportable.
3. **Ask the AI** for a draft per category (`7.1`–`7.8`, `7.7.1`), the full ten-row rubric, or a
   follow-up on a previous draft. The model sees only the captured blocks, the pinned framework text,
   the task instructions and the faculty's saved context. Every claim must cite a block by ID with
   exact Unicode code-point offsets; the server validates every citation against the snapshot and
   rejects a draft that cites text that is not there. Drafts never change a human rating.
4. **Synthesise** across 2–10 saved assessments of the same book, optionally including chosen AI
   drafts, and record a human summary, disposition and plan.
5. **Export** any review or synthesis as JSON or Markdown with full provenance: snapshot hashes,
   framework/prompt definition hashes, revision IDs, and separately labelled AI attempts with model
   and token usage.

Design rules that hold everywhere:

- AI output is a draft. `not_assessed` (AI) and `not_rated` (human) are different states; there is
  no code path that turns an AI rating into a faculty rating.
- Evidence is quoted exactly or the draft is invalid. No fetching of external references, no
  identity inferred from names or images.
- Nothing writes back to the library. Capture is read-only and anonymous.
- Everything is off by default and gated per project.

## 2. How it works

### Components

| Layer | Path (under `overlay/`) | Role |
| --- | --- | --- |
| Shared types | `shared/idea.ts` | Version-1 JSON contracts shared by server and client (no server validators reach the browser) |
| Framework | `server/util/idea/vendor/oeri-framework.ts`, `framework.ts`, `references.ts` | Pinned OERI framework text and adapted Crosswalk task guidance, with attribution, versions and content hashes |
| Contracts | `server/util/idea/contracts.ts` | Strict schemas for human reviews and every AI draft mode; completion rules; exact-quotation and scope checks |
| Prompts | `server/util/idea/prompts.ts`, `config.ts` | Prompt assembly for all 12 modes, input manifest + hash, size limits, the inference profile |
| Persistence | `server/models/idea-models.ts` and `server/models/idea*.ts` | Ten collections (below); immutable pages, revisions and definitions |
| Services | `server/api/services/idea/*.ts` | Content source (library API + anonymous HTML), normaliser, capture worker, review/revision store, permission checks, AI provider/quota/run service/worker, synthesis, export, migration, maintenance |
| API | `server/api/idea.ts`, `server/api/validators/idea.ts` | Private router at `/api/v1/projects/:projectID/idea` |
| Client | `client/src/components/projects/idea/*.tsx`, `client/src/api/idea.ts`, `client/src/types/idea.ts` | Review list/editor, capture panel, rubric form, AI run controls and draft renderer, evidence preview, synthesis views, export menu |
| Scripts | `server/scripts/idea-migrate.ts`, `idea-maintenance.ts`, `idea-export.ts` | Operational commands (bundled into the image by the Dockerfile patch) |
| Browser tests | `e2e/idea/` | Playwright workflows against the real router and workers with scripted source/provider |
| CI | `.github/workflows/idea-checks.yml` | Server + client tests, builds, browser workflows on every PR |

### Data

Ten MongoDB collections, all additive; nothing existing in Conductor is modified:

`ideaDefinitions` (immutable framework/prompt/reference definitions, hash-verified), `ideaSnapshots`,
`ideaPages` (captured blocks), `ideaSourceJobs` (capture and source-check jobs), `ideaSourceChecks`,
`ideaHeads` and `ideaRevisions` (review/synthesis records and their immutable version chains),
`ideaEstimates` (AI estimates, TTL-expired), `ideaRuns` (AI jobs, attempts, outputs, settlement),
`ideaDailyLimits` (per-actor/project/deployment quota ledgers and the global pause control).

Saves use an insert-then-conditional-pointer-swap protocol keyed by `(headID, mutationID)` and a
payload hash, so retries are idempotent and conflicting edits return `409`. A standalone MongoDB is
sufficient; no transactions or replica set are required.

### Request flow

```
faculty browser ─▶ /api/v1/projects/:id/idea/…  (JWT + session + project membership + Origin check
                                                 + pilot allowlist + storage readiness, per request)
   source-tree / captures ──▶ capture worker ──▶ library API (page, security, tree) + anonymous page HTML
                                                 └▶ normaliser ─▶ ideaPages + ideaSnapshots
   reviews / syntheses ──▶ revision store (immutable revisions, versioned heads)
   runs/estimate ──▶ prompt builder (48,000-byte input cap, hash) + quota reservation
   runs ──▶ AI worker (one global slot) ──▶ OpenAI Chat Completions, strict JSON schema, store:false
                                                 └▶ local schema + exact-evidence validation ─▶ ideaRuns
   exports ──▶ canonical JSON / Markdown of the saved record + provenance
```

### Routes

All under `/api/v1/projects/:projectID/idea`; every route requires a valid Conductor session whose
user is a lead, member or liaison of the project (auditors read/export only). Mutations additionally
require an exact `Origin` header matching `IDEA_ALLOWED_ORIGINS`, `PRODUCTIONURLS` or
`DEVELOPMENTURLS`.

| Route | Purpose |
| --- | --- |
| `GET /capabilities` | Flags, profile, disclosure text, remaining quota for this user/project |
| `GET /framework` | The pinned framework and attribution |
| `GET /source-tree?rootID=` | Public page tree of the linked book (or a smaller root) |
| `POST /captures`, `GET /captures/:id` | Start / poll a capture job |
| `POST /source-checks`, `GET /source-checks/:id` | Compare a snapshot with the current public page (read-only) |
| `GET /snapshots/:id/pages/:pageID` | Captured blocks and sanitised preview |
| `POST/GET /reviews`, `GET/PATCH /reviews/:id`, `POST /reviews/:id/transitions` | Create, list, read, edit (versioned), finish/reopen/archive |
| `POST/GET /syntheses`, `GET/PATCH /syntheses/:id`, `POST …/transitions`, `GET /syntheses/:id/coverage` | Same for syntheses, plus frozen coverage |
| `POST /runs/estimate` | Build the immutable input bundle, return hash, size, reservation and disclosure |
| `POST /runs`, `GET /runs`, `GET /runs/:id` | Submit (with `acknowledgeDataUse` + disclosure version), list, read |
| `POST /runs/:id/cancel`, `POST /runs/:id/feedback` | Owner cancel; versioned faculty disposition/note on a draft |
| `GET /exports/:kind/:id?format=json\|md` | Export a review or synthesis |

### AI execution

- Profile `idea-openai-luna-v1`: OpenAI `gpt-5.6-luna`, reasoning effort high, **one attempt, no
  fallback, no retry**. 120 s provider timeout inside a 130 s run deadline. Strict JSON schema output,
  `store:false`, `max_completion_tokens` 16,192. Hidden reasoning and raw error bodies are discarded.
- A queued run is admitted only after reserving quota in three ledgers (actor, project, deployment)
  for the current UTC day. Limits: 3 queued per user; 20 runs/user/day; 100/project/day;
  USD 2/user/day, 10/project/day, 25/deployment/day. Reservation is 36,416 micro-USD per run and
  settles to actual usage (or the full reservation if usage is unknown). An observed overrun pauses
  the deployment (`ideaDailyLimits` document `control:all`) until cleared operationally.
- One global inference slot: at most one IDEA job runs at a time per deployment. Every attempt
  rechecks session, membership, flags, budget, current revision and bundle hash; changed inputs fail
  with `INPUT_STALE`. A crash after the provider was called yields `PROVIDER_OUTCOME_UNKNOWN` — never a
  silent second call.
- Input limit: the prompt (framework lenses, task instructions, output schema counted twice, captured
  blocks with code-point lengths, saved assessments) must be ≤ **48,000 bytes**, else the estimate
  fails with `AI_INPUT_INVALID_OR_TOO_LARGE`. See §10 for what this means in practice.

## 3. Applying it to Conductor

Target: a checkout of `libretexts/conductor`. The overlay was produced from the libretexts.dev fork
(base `dcce499b`, itself derived from upstream `a69570fa`); the patch was checked against upstream
`master` `b0401094` (2026-09-02) — two hunks apply cleanly, four need the one-line manual merges
below because upstream has since converted `Conductor.jsx` to TypeScript and changed logging.

### Step 1 — copy the overlay

```sh
cd /path/to/conductor
cp -R /path/to/conductor-idea/overlay/. .
git status --short | wc -l   # expect 89 added files
```

### Step 2 — apply the patch

```sh
git apply --check /path/to/conductor-idea/patches/conductor-integration.patch   # shows which hunks fail
git apply --reject /path/to/conductor-idea/patches/conductor-integration.patch   # applies what it can, leaves *.rej
```

Then finish by hand where needed. The intent of each hunk, in full:

**`Dockerfile`** (applies cleanly): in the client build stage add `COPY shared/ ../shared/` after
`COPY client/ ./`; in the server build stage add `COPY shared/ ../shared/` after `COPY server/ ./` and,
after `RUN npm run build`, bundle the operational scripts:

```dockerfile
RUN npx --no-install tsup scripts/idea-migrate.ts scripts/idea-export.ts scripts/idea-maintenance.ts --format esm --out-dir dist/scripts
```

**`server/api.js`** (manual): three lines.

```js
import ideaRouter, { ideaJSONParser, ideaError } from "./api/idea.js";   // with the other imports
// immediately after `router.use(corsMiddleware);` and BEFORE the global body parser:
router.use("/projects/:projectID/idea", ideaJSONParser, ideaError);
// after `router.use(authAPI.optionalVerifyRequest); router.use(rateLimitMiddleware);`:
router.use("/projects/:projectID/idea", ideaRouter);
```

The order matters: IDEA's parser (256 KiB limit, unknown fields rejected) must run before the global
parser, and the router must run after the optional auth verifier and rate limiter.

**`server/server.ts`** (manual): import the two workers, start them once MongoDB is connected, drain
them on shutdown.

```ts
import { startCaptureWorker } from "./api/services/idea/capture-worker.js";
import { startAIWorker } from "./api/services/idea/ai-worker.js";
let stopIdeaAI: (() => globalThis.Promise<void>) | undefined;
let stopIdeaCapture: (() => globalThis.Promise<void>) | undefined;
// where the successful MongoDB connection is logged ("Connected to MongoDB"):
stopIdeaCapture ??= startCaptureWorker();
stopIdeaAI ??= startAIWorker();
// in shutdown(), before server.close(): 
const ideaDrain = globalThis.Promise.all([stopIdeaCapture?.(), stopIdeaAI?.()]);
// inside the server.close callback, before mongoose.disconnect():
await ideaDrain;
```

(`globalThis.Promise` because Conductor's `server.ts` imports bluebird's `Promise`.)

**`server/util/librariesclient.ts`** (manual): add an optional `signal?: AbortSignal` parameter to
`getLibraryCredentials(lib)` and `generateAPIRequestHeaders(lib)`, pass `{ abortSignal: signal }` as the
second argument of `this.ssm.send(new GetParametersByPathCommand(...))`, and forward `signal` from
`generateAPIRequestHeaders` to `getLibraryCredentials`. This lets a capture's 15-second deadline cover
the SSM lookup. No behaviour change when the signal is omitted.

**`client/src/Conductor.tsx`** (manual; upstream renamed the file): import the two screens and add
two private routes next to `/projects/:id`:

```tsx
import SynthesisView from './components/projects/idea/SynthesisView';
import ProjectIdeaReview from './components/projects/idea/ProjectIdeaReview';
<PrivateRoute exact path='/projects/:id/idea-syntheses/:synthesisID?' component={SynthesisView} />
<PrivateRoute exact path='/projects/:id/idea/:reviewID?' component={ProjectIdeaReview} />
```

**`client/src/components/projects/ProjectView.jsx`** (applies cleanly): import `IdeaProjectLink` and
render `<IdeaProjectLink projectID={props.match.params.id} />` beside the Peer Review button. The link
renders nothing unless the project's IDEA capability says review is enabled.

### Step 3 — dependencies

No new server or client dependencies. The server uses the existing `openai`, `mongoose`, `zod`,
`cheerio` and `@aws-sdk/client-ssm` packages; the client uses the existing `@tanstack/react-query`
and router. `e2e/idea/` has its own pinned `package.json`/lockfile (Playwright, Vite) and is not part
of either app's dependency tree.

### Step 4 — build and migrate

```sh
npm --prefix server ci --legacy-peer-deps && npm --prefix client ci
npm --prefix server run build && npm --prefix client run build
# with MONGOOSEURI pointing at the intended database:
cd server && npx --no-install tsx scripts/idea-migrate.ts && npx --no-install tsx scripts/idea-migrate.ts --check
```

Migration is additive and idempotent: it creates the ten collections and their indexes (never drops
existing ones) and inserts three hash-verified definitions (framework, prompt pack, reference).
`--check` fails on missing indexes or drifted definitions. In a built image the same commands are
`node dist/scripts/idea-migrate.js [--check]`.

## 4. Configuration

All flags default to off. Nothing is reachable until a project is allow-listed.

| Variable | Meaning |
| --- | --- |
| `IDEA_REVIEW_ENABLED` | `true` allows human review creation/editing for allow-listed projects. Off = existing reviews stay readable/exportable, nothing new. |
| `IDEA_WORKER_ENABLED` | `true` runs the capture worker, so captures and source checks can be submitted. |
| `IDEA_AI_ENABLED` | `true` allows AI estimates and runs. Requires the other two. |
| `IDEA_PILOT_PROJECT_IDS` | JSON array of Conductor project IDs, e.g. `["AbCdEfGhIj"]`. Empty = nobody. Project IDs are exactly 10 characters. |
| `IDEA_ALLOWED_ORIGINS` | Optional comma-separated exact origins accepted for mutations, in addition to `PRODUCTIONURLS` / `DEVELOPMENTURLS`. No trailing slashes. |
| `OPENAI_API_KEY` | The centrally managed key used for inference. Presence enables the AI capability; it is not validated until a run is submitted. |
| `REMEDY_FALLBACK_PROVIDER`, `…_BASE_URL`, `…_TEXT_MODEL`, `…_REASONING_EFFORT`, `…_REASONING_TOKEN_BUDGET` | Optional. If present (shared with the remediation feature) they must equal `openai`, `https://api.openai.com/v1`, `gpt-5.6-luna`, `high`, `8192`; a mismatch fails closed with `AI_PROFILE_MISMATCH`. |
| `AWS_REGION`, AWS credentials, `AWS_SSM_LIB_TOKEN_PAIR_PATH` (default `/libkeys/production`), `LIBRARIES_API_USERNAME` | **Production.** Conductor's existing library-token path. IDEA's metadata reads (page, security, tree) use `generateAPIRequestHeaders(library)` from `librariesclient.ts`, so the deployment needs whatever Conductor already needs to talk to a library's API. Page HTML is always fetched anonymously. |
| `IDEA_LIBRARY_HOSTS` | **Demo only.** JSON map of library slug → hostname, e.g. `{"mirror":"library.example.test"}`. A mapped library is read from that host instead of `<slug>.libretexts.org`, **anonymously, with no SSM lookup and no token**. Unset in production. Malformed values fail closed (`LIBRARY_HOSTS_MISCONFIGURED`). |

Also required: a document in Conductor's `libraries` collection for the book's library (`subdomain`
matching the project's `libreLibrary`, `hidden:false`) — IDEA refuses books from libraries that are
not in that allowlist — and a project whose `libreLibrary`/`libreCoverID` point at the book's cover
page and whose `leads`/`members`/`liaisons` include the faculty user.

Recommended enablement order for a new deployment: migrate → `IDEA_REVIEW_ENABLED` +
`IDEA_WORKER_ENABLED` + allowlist one project → confirm capture and review work → `IDEA_AI_ENABLED`.
Flags are read at request time, but Conductor's process must be restarted/recreated to pick up new
environment values.

## 5. Running it

1. Open the project; an **IDEA Review** button appears beside Peer Review when the project is
   allow-listed and review is enabled. It leads to `/projects/<id>/idea`.
2. Fill **Review context** (discipline, intended use/extent, depth, focus categories, destination,
   licence context, optional prompt adjustment), tick "I am familiar with this chapter", press
   **Discover public chapter pages**, pick a chapter root and the pages to capture, press **Capture
   selected pages**. Capture runs in the background and the page polls until done. A capture that
   excludes pages is `partial` and must be acknowledged when creating the review.
3. In the chapter review: the **Faculty assessment** rubric (ten rows; a legend explains the rating
   scale), notes, summary, suggestions and revision plan; **AI Crosswalk drafts** — choose a task (a
   panel explains what that category asks, quoting the framework), **Save and estimate**, read the
   disclosure and cost, tick the agreement, **Request draft**; the draft renders with "Check captured
   evidence" buttons that open the cited blocks. Record a disposition and note per draft. Proposals
   from a draft can be added to the revision plan explicitly; nothing is adopted automatically.
4. **Finish** requires a judgment on all ten rows and an explanation for every Not Applicable.
   Finished records are read-only until reopened.
5. **Compare chapters in a synthesis** (link at the top of the IDEA page): select 2–10 saved
   assessments, optionally include chosen AI drafts, create, optionally request a synthesis draft,
   write the human summary/plan, finish.
6. **Export** JSON or Markdown from the export menu on any record.

## 6. Operating it

```sh
# Inside the container (scripts are bundled by the Dockerfile patch):
node dist/scripts/idea-migrate.js --check      # storage readiness
node dist/scripts/idea-maintenance.js          # dry run: unreachable candidates, corrupt chains
node dist/scripts/idea-maintenance.js --apply  # remove unreachable payloads older than 7 days; never touches committed data
# Read-only export without the UI (needs MONGOOSEURI, IDEA_EXPORT_ACTOR_UUID, IDEA_EXPORT_SESSION_ID in the environment):
node dist/scripts/idea-export.js PROJECT_ID review|synthesis RECORD_UUID REVISION_UUID json|md OUTPUT_PATH
```

**Disable and drain.** Set `IDEA_AI_ENABLED=false` first and leave the worker running: queued jobs
are repaired to `failed / AI_DISABLED` and their reservations settled. Then check `ideaRuns` has no
`admission`, `queued` or `running` documents and no unsettled terminal rows, and `ideaDailyLimits`
has no open reservations. Then set `IDEA_REVIEW_ENABLED=false` if human mutation must stop. Never
delete a lease or reset a ledger document to make a drain look complete.

**Rollback.** Retain all IDEA collections (they are additive) and keep a compatible server version
available for exports. There is no down-migration and none is needed; disabling the flags is the
rollback for users.

**Spending pause.** An overrun sets `ideaDailyLimits` `_id: "control:all"` `paused:true`. Fix the
cause, then clear the flag deliberately.

## 7. Tests and CI

Node 22 and a standalone MongoDB 7 bound to loopback. Tests refuse remote hosts, credentials,
connection options and database names outside `idea_test_*`, and drop the named database.

```sh
# server (145 tests at handoff; the Mongo/HTTP suite is skipped without IDEA_TEST_MONGO_URI)
IDEA_TEST_MONGO_URI=mongodb://127.0.0.1:27028/idea_test_checks npm --prefix server test
npm --prefix client test          # 24 tests
npm --prefix server run build && npm --prefix client run build
# browser workflows (real router, workers and Mongo; scripted source and provider; ports 3199/3200)
npm --prefix e2e/idea ci && (cd e2e/idea && npx playwright install chromium) && npm --prefix e2e/idea test
```

`.github/workflows/idea-checks.yml` runs all of the above on pull requests with a Mongo service
container and no provider secrets. It had not yet been run on GitHub at handoff.

Normal tests never call a real provider. The `fixtures/` directory (fictional chapters, scripted
provider) is imported only by tests.

## 8. The proof-of-concept mirror (demo only)

The libretexts.dev deployment had no AWS/SSM access to library API tokens, so it captured from its
own static mirror of public books instead of `<library>.libretexts.org`. Two pieces make that work;
a production deployment uses neither.

1. **`IDEA_LIBRARY_HOSTS`** in Conductor (see §4): points one library slug at the mirror host and
   reads it anonymously.
2. **`demo/idea_index.py`** on the mirror: for every page under `site/Books/<book>/…` it assigns a
   stable numeric page ID (persisted in `site/@api/deki/_ids.json`), writes the three Deki-shaped
   JSON files Conductor's capture reads (`page.json`, `security.json` = Public, `tree.json` from the
   directory nesting), and stamps each page with `<div id="pageIDHolder" hidden>ID</div>` and the
   `mt-content-container` class the normaliser looks for. `demo/caddy-library-rewrites.caddy` maps the
   Deki request paths onto those files. Run the indexer after every import:
   `python3 idea_index.py --site /path/to/mirror/site --host library.example.test`.

`demo/conductor-environment.example.yml` shows the compose `environment:` lines the demo used
(with a placeholder key). A production Conductor sets the same `IDEA_*` flags, omits
`IDEA_LIBRARY_HOSTS`, and relies on its existing SSM library-token configuration.

## 9. What was verified

On the proof-of-concept deployment, before handoff:

- Full loop in the browser by the project owner: capture from the mirror (French OER 1, Unit 3 +
  section 3.1; 20 pages recorded as excluded) → review → JSON export with provenance → AI draft for
  7.1 on `gpt-5.6-luna` with evidence links.
- A 22-case qualification matrix on two public CC BY sections (nine category tasks + rubric on each,
  one follow-up, one synthesis): 22/22 runs succeeded and passed schema and exact-evidence
  validation; 0 timeouts, 0 truncations; latency 8.7 / 36.0 / 73.1 s (min / median / max); settled
  cost USD 0.128 total (ledger equals the published tariff). An assistant-level content review of all
  22 drafts against every source block found no factual errors, no fabricated evidence and no
  identity inferred from names or images; 17 drafts useful as-is, 5 needing correction (see §10),
  0 rejected. This is assistant review, not faculty acceptance.
- Server suite 145/145, client 24/24, both production builds, migration `--check` clean against the
  live database.

## 10. Known limits and open work

Ordered by how much they matter to a production decision.

1. **The 48,000-byte AI input cap makes real chapters too large.** Fixed overhead (framework
   lenses, task instructions, output schema — counted twice by design) is ~15–21 KB; captured blocks
   cost roughly 2.5–3× their text size. In practice a single page of ~4–7 KB of text fits every task;
   a page with many short blocks (e.g. a French vocabulary section, 209 blocks / 9 KB) already
   exceeds the cap for most tasks; a multi-page chapter never fits. Synthesis (which needs ≥2 whole
   snapshots) fits only for two very short sections. Options: raise the cap and requalify, drop the
   duplicated schema from the payload (saves ~8 KB per synthesis prompt), or an input-packing change
   that sends only cited blocks. Any change re-hashes every prompt and needs requalification.
2. **Rubric drafts are over-conservative.** The full-rubric draft rated every row `not_assessed` on
   pages where the same model's single-category drafts rated 7.3 and 7.6 as inclusive/clean. Rubric
   drafts should carry scope-qualified ratings. Related: the UI shows rubric `not_assessed` rows next
   to adopted chapter findings without reconciling them.
3. **Corrections found in the qualification review** (patterns to watch, not fixed in code): a 7.1
   draft ignored an adjacent textual image description and suggested marking an instructional figure
   decorative; a 7.5 draft manufactured five boilerplate "scenarios" from licensing rules; a 7.6 draft
   proposed rewriting neutral conventional phrases ("American History textbook", "Chinese students").
4. **Synthesis is qualified only for empty inputs.** The matrix's synthesis ran over two blank
   reviews and correctly reported nothing to synthesise. Synthesis over completed faculty ratings has
   not been exercised live.
5. **Production gates not exercised on the proof-of-concept:** the AWS/SSM library-token path (the
   demo bypassed it), assistive-technology review beyond an automated axe pass on one view, a backup
   and retention policy for pilot data, and the CI workflow on GitHub.
6. **Zero proposals were ever adopted into a revision plan**, so that path is covered by automated
   tests only.
7. **Provider profile is fixed.** One model, one attempt, no fallback, by decision. Changing the model
   means a new profile ID and a new qualification run.

## 11. File map

```
overlay/
  .github/workflows/idea-checks.yml
  shared/idea.ts
  server/api/idea.ts
  server/api/validators/idea.ts
  server/api/services/idea/
    ai-provider.ts ai-quota.ts ai-run-service.ts ai-worker.ts capture-config.ts capture-service.ts
    capture-worker.ts content-source.ts errors.ts export-service.ts live-provider.ts
    maintenance-service.ts migration-service.ts normalizer.ts permission-service.ts
    review-service.ts revision-store.ts source-check-service.ts synthesis-service.ts
  server/models/idea-models.ts ideadailylimit.ts ideadefinition.ts ideahead.ts ideapage.ts
    idearevision.ts idearun.ts ideasnapshot.ts ideasourcecheck.ts ideasourcejob.ts
  server/scripts/idea-migrate.ts idea-maintenance.ts idea-export.ts
  server/util/idea/
    config.ts contracts.ts framework.ts prompts.ts references.ts test-database.ts
    vendor/oeri-framework.ts vendor/LICENSE.oer2canvas vendor/provenance.json
    fixtures/ (test-only)  *.test.ts
  client/src/api/idea.ts idea.test.ts
  client/src/types/idea.ts
  client/src/components/projects/idea/
    ProjectIdeaReview.tsx CaptureStatus.tsx ReviewSetup.tsx RubricForm.tsx RunControls.tsx
    CrosswalkDraft.tsx EvidencePreview.tsx RevisionPlan.tsx ExportMenu.tsx IdeaProjectLink.tsx
    SynthesisSetup.tsx SynthesisView.tsx framework-help.ts saveCoordinator.ts synthesisSelection.ts
    idea.css  *.test.ts
  e2e/idea/ (Playwright harness: package.json, playwright.config.ts, vite.config.mjs, main.tsx, index.html, workflows.spec.ts)
patches/conductor-integration.patch
demo/idea_index.py  demo/caddy-library-rewrites.caddy  demo/conductor-environment.example.yml
LICENSE  NOTICE  README.md
```

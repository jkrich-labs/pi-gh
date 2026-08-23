# pi-gh — Work breakdown

## S-01 — Establish the package and one end-to-end repository view

- **Delivers:** An installable pi package whose `gh_view` tool accepts a github.com repository target, executes a strict `gh repo view --json ...` argv through an injected adapter, and returns a bounded compact projection or classified error.
- **Blocked by:** none
- **Consumes:** pi extension registration, `pi.exec`, TypeBox, and the external `gh` executable contract.
- **Produces:** Operation registry contract; `GhExecutor` production/fake adapters; execution pipeline for target resolution, argv execution, JSON decode, errors, projection, and token budgeting; package verification commands.
- **Seam(s) to test at:** Registered model-facing operation tool executed with fake adapters.
- **Tier:** general — greenfield package setup plus the deep execution seam and first tracer path require coordinated design.
- **Est. cost:** ~18k tokens / 30–45 minutes
- **Acceptance criteria:**
  - [x] `npm ci` installs the locked development toolchain without runtime dependencies beyond declared peers.
  - [x] `npm run typecheck` passes in strict NodeNext mode.
  - [x] `node --test tests/view-repository.test.ts` proves URL, `owner/repo`, current-checkout, success, missing `gh`, unsupported version, malformed JSON, auth, permission, not-found, timeout, and abort behavior through `gh_view`.
  - [x] `node --test tests/security.test.ts` proves argv is passed as an array, shell metacharacters remain data, and credentials never appear in projections or errors.
  - [x] `npm pack --dry-run` includes the extension, package metadata, README, and license, and excludes tests, fixtures, and scratch artifacts.
- **Status:** done
- **Resolutions:** S-01 implements github.com repository view only. Issue, pull-request, and other resource targets stay rejected until S-02. Token-budget and temporary-output hooks exist in the pipeline; their acceptance tests stay in later slices. The empty directory had no git repository; S-01 initializes one so slice commits are possible.

## S-02 — Complete the URL fast path and lazy capability loading

- **Delivers:** Initially active `gh_view` and `gh_find` tools. `gh_view` recognizes repository, issue, pull request, commit, release, workflow-run, job, file, tree, and compare targets on github.com and authenticated GHES hosts. `gh_find` deterministically loads the smallest ranked set of exact operation tools without disturbing unrelated tools.
- **Blocked by:** S-01
- **Consumes:** Operation registry, target resolver, execution pipeline, and fake adapters from S-01.
- **Produces:** Stable registry metadata and activation interface consumed by every later operation slice; normalized resource-target shapes; host authentication cache.
- **Seam(s) to test at:** Registered `gh_view`/`gh_find` tools plus the extension active-tool interface.
- **Tier:** general — URL grammar, host safety, dynamic activation, and coexistence with other extensions span several concerns but are well scoped.
- **Est. cost:** ~24k tokens / 45–60 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/view-targets.test.ts` passes fixtures for every supported github.com and GHES URL/identifier shape, ambiguity error, unsupported URL, and normalized target.
  - [ ] `node --test tests/loader.test.ts` proves synonym ranking, bounded matches, additive activation, repeat calls, reload behavior, and preservation of unrelated active tools.
  - [ ] `node --test tests/registry-contract.test.ts` proves every operation has a unique `gh_` name, strict schema, aliases, read/routine/guarded classification, argv fixture, decoder fixture, and projector fixture.
  - [ ] `node --test tests/auth-hosts.test.ts` proves only github.com and authenticated configured GHES hosts are accepted and auth JSON is inspected without token-display flags.
  - [ ] `node --test tests/token-budget.test.ts --test-name-pattern='initial tools'` proves combined `gh_view` and `gh_find` metadata stays within 800 estimated tokens.
  - [ ] `npm run typecheck` passes.
- **Status:** done
- **Resolutions:** `owner/repo#N` is ambiguous unless `gh_view` receives an explicit `kind` hint. github.com is always an allowed host; other hosts must appear as authenticated in `gh auth status --json hosts`. S-02 registers only `gh_view` and `gh_find`; later slices add operation tools to the same registry and contract tests.

## S-03 — Add bounded search and repository content reads

- **Delivers:** Lazy tools for issue, pull-request, repository, code, and commit search; repository file and directory reads at a ref; and pull-request file-list and diff inspection. Every result has explicit limits, default/expanded projections, and secure truncation fallback.
- **Blocked by:** S-02
- **Consumes:** Registry/activation contract, normalized targets, execution pipeline, token budgeting, and secure temporary-output handling.
- **Produces:** Search and content operation metadata usable by `gh_find`; reusable bounded-list projection behavior.
- **Seam(s) to test at:** Each registered search/content tool executed with fake `gh` responses.
- **Tier:** general — several read operations share infrastructure but need distinct schemas and projection fixtures.
- **Est. cost:** ~18k tokens / 30–45 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/search.test.ts` proves each search kind, repository scoping, query preservation, default/max limits, empty results, pagination bounds, and classified errors.
  - [ ] `node --test tests/content.test.ts` proves file/ref reads, directory listing, PR files, PR diff, binary response handling, and unsafe path rejection.
  - [ ] `node --test tests/truncation.test.ts` proves default results stay within 2,000 estimated tokens, expanded results within 8,000, and larger content reports counts plus a restrictive temporary path.
  - [ ] `node --test tests/loader.test.ts --test-name-pattern='search|content|diff'` proves representative tasks load the expected exact tools.
  - [ ] `npm run typecheck` passes.
- **Status:** done

## S-04 — Add CI and checks diagnosis

- **Delivers:** Lazy tools to list and inspect workflow runs and jobs, view pull-request checks, and retrieve failed logs with bounded, partial-aware projections.
- **Blocked by:** S-02
- **Consumes:** Registry/activation contract, run/job target normalization, execution pipeline, bounded-list and truncation behavior.
- **Produces:** CI operation metadata and normalized run references consumed by guarded Actions writes.
- **Seam(s) to test at:** Registered CI tools executed with fake run, job, check, and log responses.
- **Tier:** general — CI result shapes and partial log behavior are nuanced but contained behind existing seams.
- **Est. cost:** ~16k tokens / 30–40 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/ci.test.ts` proves run list/view, attempt selection, job view, PR checks, success/failure/pending conclusions, and repository qualification.
  - [ ] `node --test tests/ci-logs.test.ts` proves failed-step selection, `UNKNOWN STEP`, missing-log fallback errors, partial results, line/byte limits, timeout, and abort behavior.
  - [ ] `node --test tests/token-budget.test.ts --test-name-pattern='CI'` proves summary and expanded CI projections meet the 2,000/8,000-token budgets.
  - [ ] `node --test tests/loader.test.ts --test-name-pattern='checks|workflow|failed logs|job'` proves representative diagnosis tasks load the correct tools.
  - [ ] `npm run typecheck` passes.
- **Status:** done

## S-05 — Add issue writes and confirmation policy

- **Delivers:** Exact lazy tools to create, comment on, edit, assign, label, close, and reopen issues. Routine writes run directly; closure is guarded with exact-target confirmation and fails closed without UI.
- **Blocked by:** S-02
- **Consumes:** Registry/activation contract, normalized issue targets, execution pipeline, and confirmation adapter.
- **Produces:** Shared guarded-write flow and mutation-result projection used by later write slices.
- **Seam(s) to test at:** Registered issue tools with fake executor and confirmation adapters.
- **Tier:** general — write correctness and safety need careful external-behavior coverage across multiple exact tools.
- **Est. cost:** ~14k tokens / 25–35 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/issue-writes.test.ts` proves exact argv and result projections for create, comment, metadata edit, assignment, labels, close, and reopen.
  - [ ] `node --test tests/guards.test.ts --test-name-pattern='issue'` proves closure shows normalized target/effect, decline executes nothing, approval executes once, and no-UI mode fails closed.
  - [ ] `node --test tests/security.test.ts --test-name-pattern='write bodies'` proves multiline bodies, mentions, quotes, and shell metacharacters remain argv/stdin data.
  - [ ] `node --test tests/loader.test.ts --test-name-pattern='issue write'` proves issue-writing prompts load only relevant exact tools.
  - [ ] `npm run typecheck` passes.
- **Status:** done

## S-06 — Add pull-request writes

- **Delivers:** Exact lazy tools to create, comment on, edit, review, close, reopen, merge, and update pull-request branches. Merge, closure, branch update, approval, and request-changes reviews use guarded confirmation.
- **Blocked by:** S-02, S-05
- **Consumes:** Registry/activation contract, normalized PR targets, execution pipeline, and guarded-write flow from S-05.
- **Produces:** PR mutation metadata and projections.
- **Seam(s) to test at:** Registered PR tools with fake executor and confirmation adapters.
- **Tier:** general — merge methods, reviews, and branch updates have operation-specific invariants and safety effects.
- **Est. cost:** ~18k tokens / 35–50 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/pr-writes.test.ts` proves exact argv and projections for every planned PR write, merge method, draft/body fields, reviewers, assignees, and labels.
  - [ ] `node --test tests/guards.test.ts --test-name-pattern='pull request|review|merge|branch'` proves each guarded effect, decline path, single execution, and headless failure.
  - [ ] `node --test tests/pr-writes.test.ts --test-name-pattern='conflict|not mergeable|required checks|permission'` proves distinct classified failures.
  - [ ] `node --test tests/loader.test.ts --test-name-pattern='pull request write'` proves representative prompts load the exact intended PR tool.
  - [ ] `npm run typecheck` passes.
- **Status:** done

## S-07 — Add guarded Actions and release writes

- **Delivers:** Exact lazy tools for workflow dispatch, run cancel/rerun, release create/edit, asset upload, release deletion, and asset deletion. Compute, publication, and deletion effects are confirmed and headless-safe.
- **Blocked by:** S-04, S-05
- **Consumes:** CI run references from S-04, guarded-write flow from S-05, registry/activation contract, and execution pipeline.
- **Produces:** Complete planned v1 mutation catalogue.
- **Seam(s) to test at:** Registered Actions/release tools with fake executor, file fixtures, and confirmation adapters.
- **Tier:** general — compute triggers and file upload require operation-specific safety, timeout, and cancellation behavior.
- **Est. cost:** ~16k tokens / 30–45 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/actions-writes.test.ts` proves workflow/ref/input handling and run cancel/rerun argv, projections, errors, timeout, and cancellation.
  - [ ] `node --test tests/release-writes.test.ts` proves create/edit/upload/delete operations, asset-path validation, immutable-release errors, and upload cancellation.
  - [ ] `node --test tests/guards.test.ts --test-name-pattern='workflow|run|release|asset'` proves exact confirmation text, decline, one-shot execution, and fail-closed headless behavior.
  - [ ] `node --test tests/loader.test.ts --test-name-pattern='dispatch|rerun|cancel|release'` proves representative prompts load the exact intended tools.
  - [ ] `npm run typecheck` passes.
- **Status:** done

## S-08 — Add the typed GET-only API fallback

- **Delivers:** A lazy `gh_api_get` tool for uncommon REST reads with authenticated host selection, typed query parameters, explicit GET method, bounded pagination, cache option, and projection controls. Mutation methods, GraphQL, custom headers, and arbitrary input remain impossible through its schema.
- **Blocked by:** S-02
- **Consumes:** Host allowlist, registry/activation contract, execution pipeline, bounded pagination, and projection budgets.
- **Produces:** Read escape hatch for resources not covered by focused tools.
- **Seam(s) to test at:** Registered fallback tool executed with fake API responses.
- **Tier:** general — the interface is small, but proving it cannot silently become a write path requires careful validation.
- **Est. cost:** ~10k tokens / 20–30 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/api-get.test.ts` proves endpoint normalization, forced GET, typed query parameters, host selection, pagination cap, caching, jq/projection behavior, and error classification.
  - [ ] `node --test tests/api-get.test.ts --test-name-pattern='rejects'` proves absolute non-GitHub URLs, GraphQL, non-GET methods, request bodies, custom headers, previews, file expansion, and unsafe placeholders cannot execute.
  - [ ] `node --test tests/token-budget.test.ts --test-name-pattern='API GET'` proves default and expanded fallback results meet the 2,000/8,000-token budgets.
  - [ ] `node --test tests/loader.test.ts --test-name-pattern='uncommon|REST|API read'` proves fallback discovery without outranking focused tools for covered tasks.
  - [ ] `npm run typecheck` passes.
- **Status:** done

## S-09 — Prove reliability and prepare the public release

- **Delivers:** Complete offline verification, credential-gated live model evaluation, CI, documentation, install instructions, compatibility checks, security notes, and publishable package contents. The release report records token overhead and model tool-call accuracy.
- **Blocked by:** S-03, S-04, S-05, S-06, S-07, S-08
- **Consumes:** Complete operation catalogue, registry fixtures, projection budgets, package metadata, and all verification commands.
- **Produces:** `verify` and live-eval interfaces used for release approval; npm/git-ready package and user documentation.
- **Seam(s) to test at:** Full registered extension interface; live prompts stop after capturing and validating tool calls before GitHub mutation execution.
- **Tier:** general — evaluation harness, release gates, CI, and public documentation require multi-file coordination but no novel architecture.
- **Est. cost:** ~20k tokens / 40–60 minutes plus live model latency
- **Acceptance criteria:**
  - [ ] `npm run verify` passes typecheck, registry contracts, every offline behavior suite, token budgets, and package checks.
  - [ ] `npm run smoke:gh` passes against installed `gh` without mutating GitHub and reports the detected pi/gh versions and authenticated hosts without credentials.
  - [ ] `npm run eval:live -- --provider openai-codex --model gpt-5.6-sol` scores at least 95% exact operation and normalized target, 100% schema-valid calls, and zero unsafe write misroutes across URL reads, discovery, searches, CI, routine writes, guarded writes, GHES, malformed targets, and adversarial prompts.
  - [ ] `npm run eval:report` emits per-fixture failures, aggregate accuracy, schema validity, unsafe-write count, and initial/result token measurements in machine-readable JSON and concise Markdown.
  - [ ] `npm pack --dry-run` contains only intended public artifacts and reports no bundled credentials, fixtures, temporary output, or scratch files.
  - [ ] `pi -e . -p 'Inspect https://github.com/cli/cli using the GitHub extension and respond with only the repository name.'` completes through `gh_view` with the package loaded from its root.
  - [ ] CI runs `npm ci` and `npm run verify` on Node 24; a separately gated job can run the live model suite when credentials and the release flag are present.
- **Status:** done
- **Resolutions:** Offline verification, package dry-run, CI, smoke-check, and a credential-gated live evaluation through pi JSON event mode are implemented. The live runner uses a fake gh executable to capture model tool calls without mutating GitHub. The configured pi evaluation passed 4/4 fixtures with 100% schema validity and zero unsafe write misroutes.

## Cost and dependency summary

- **Sequential spine:** S-01 → S-02 → S-09.
- **Parallel after S-02:** S-03, S-04, S-05, and S-08.
- **Additional edges:** S-05 → S-06; S-04 + S-05 → S-07.
- **Estimated implementation total:** ~154k tokens plus live-evaluation calls.
- **Tier distribution:** all slices are `general`; none justify premium `senior`, mechanical-only, or visual agents.

# pi-gh

`pi-gh` gives pi a compact, typed interface to GitHub through the authenticated `gh` CLI.

The package does not bundle `gh`, store credentials, or accept shell commands. It executes fixed argv arrays and keeps routine results within token budgets.

## Requirements

- pi 0.84.2 or newer
- GitHub CLI 2.81.0 or newer
- Node.js 24 or newer for development
- An authenticated `gh` account for each GitHub Enterprise host you use

## Install

```bash
pi install /path/to/pi-gh
```

Load it for one run:

```bash
pi -e /path/to/pi-gh
```

Git and npm installation are also supported when the package is published.

## Use

`gh_view` and `gh_find` are active when the extension loads. Use `gh_view` for a repository or GitHub URL:

```text
Inspect https://github.com/cli/cli
```

Use `gh_find` for less common operations. It activates only the exact operation tools needed for the task. The package includes bounded search, content, CI, pull-request, Actions, release, write, and read-only REST GET tools.

## Safety

- GitHub writes use exact operation tools rather than arbitrary argv.
- Guarded writes ask for confirmation and fail closed without confirmation UI.
- The API fallback permits only relative REST GET paths, typed query fields, authenticated hosts, bounded pagination, and safe path projections.
- GraphQL, mutation methods, headers, request bodies, input files, binary downloads, and raw shell syntax are rejected.
- Credentials are not stored and are redacted from projections, errors, diagnostics, and temporary output.
- Large results are bounded and written only to restrictive temporary files when needed.

## Development

```bash
npm ci
npm run verify
npm run smoke:gh
```

`verify` runs strict typechecking, the offline suite, and the package dry-run. `smoke:gh` reports the detected CLI version and authenticated host names without displaying credentials.

The credential-gated live evaluation runs prompts through pi in JSON event mode. It uses a fake `gh` executable so model tool calls are captured without changing GitHub:

```bash
PI_GH_LIVE_EVAL_RESULT=./evaluation.json \
  npm run eval:live -- --provider openai-codex --model gpt-5.6-sol
npm run eval:report -- ./evaluation.json
```

Live release approval requires at least 95% exact operation-and-target accuracy, 100% schema-valid calls, and zero unsafe write misroutes.

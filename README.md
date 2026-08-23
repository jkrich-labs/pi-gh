# pi-gh

A [pi](https://github.com/earendil-works/pi) package that gives models a compact interface to GitHub through the authenticated `gh` CLI.

`gh` stays an external executable. This package does not bundle the CLI, store credentials, or accept raw shell arguments.

## Requirements

- pi 0.84.2 or newer
- GitHub CLI 2.81.0 or newer, authenticated for the hosts you use
- Node.js 24 or newer for development

## Install

```bash
pi install /path/to/pi-gh
```

Or load it for one run:

```bash
pi -e /path/to/pi-gh
```

You can also install from npm or git once the package is published.

## Use

Paste a repository URL or `owner/repo` into `gh_view`. Omit the target to inspect the current checkout.

```text
Inspect https://github.com/cli/cli
```

Later slices add search, content, CI, writes, and a GET-only API fallback through `gh_find`.

## Development

```bash
npm ci
npm run typecheck
npm test
```

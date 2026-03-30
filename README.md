# dp-publish-workflow

Public GitHub Action that turns a minimal Markdown template repo into a published site on `dp-workers`.

## Inputs

- `template-dir` (default `.`): path to the template repository workspace
- `publish-url` (default `https://dp-workers.brendongorelik.workers.dev/v1/publish`)
- `publish-audience` (default `dp-workers.brendongorelik.workers.dev-publish-v0`)
- `root-domain` (default `dp-workers.brendongorelik.workers.dev`)

## Caller example

```yaml
name: Build and Publish Docs

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: BrendonGor/dp-publish-workflow@main
```

## Contract with dp-workers

The action sends:

- `manifest.subdomain` from `site.config.yaml`
- `bundle_base64` containing a zip of the Astro `dist/` output

This matches `dp-workers` `POST /v1/publish`.

## References

- GitHub OIDC in Actions:
  https://docs.github.com/actions/reference/security/oidc
- Astro Starlight configuration:
  https://starlight.astro.build/reference/configuration/

# CorribFlow — Claude Code conventions

## Container Runtime
- Always use Podman, never Docker, for all container operations (build, run, compose).
- If a script or command defaults to `docker`, replace it with `podman` explicitly.

## Shell Scripts
- Use `#!/usr/bin/env bash` and bash syntax (not sh) for all shell scripts in this project.
- Test scripts locally before committing when possible.

## Before Making Changes
- Before making changes that affect user-visible behaviour (Telegram notifications, chart bounds, alert thresholds), confirm scope: is this an additive change, a replacement, or a global default?
- Prefer asking a one-line clarifying question over assuming threshold-only vs. always-on behaviour.

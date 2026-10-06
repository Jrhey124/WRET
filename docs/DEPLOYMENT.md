# Docker deployment

## Local workstation

```sh
docker compose up --build -d
```

Open **http://localhost:8080**. Localhost is a browser secure context, so Web Crypto and IndexedDB work without a local certificate. The port binds to loopback only. The final image contains nginx and static assets; Node and build dependencies stay in the build stage.

If Docker Desktop is installed per-user on Windows but `docker` is not on PATH, open its integrated terminal or temporarily add `$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin` to PATH.

```sh
docker compose ps
docker compose logs wret
docker compose exec wret nginx -t
docker compose down
```

The service runs as the base image's unprivileged nginx user, with a read-only root filesystem, a writable `/tmp` tmpfs, dropped capabilities and a health check. See the [nginx unprivileged image documentation](https://github.com/nginx/docker-nginx-unprivileged) for its `/tmp` and port conventions.

## HTTPS on a server

Use HTTPS for any non-localhost origin. Web Crypto requires a secure context; plain HTTP on a LAN IP is insufficient.

Point a hostname at your server and allow inbound TCP ports 80 and 443, then set `WRET_DOMAIN`:

```sh
export WRET_DOMAIN=wret.example.com
docker compose -f compose.yaml -f compose.https.yaml up --build -d
```

PowerShell equivalent:

```powershell
$env:WRET_DOMAIN = 'wret.example.com'
docker compose -f compose.yaml -f compose.https.yaml up --build -d
```

Caddy obtains and renews the TLS certificate and forwards requests to the static nginx service. Its named volumes store certificates/configuration only. WRET evidence never enters these volumes. Alternatively, place the base service behind your existing HTTPS reverse proxy, preserving security headers and serving the app at the origin root.

The inherited `127.0.0.1:8080` mapping remains local to the server; HTTPS is the public entry point. Deploy behind your organization's access controls if the application itself should be restricted. WRET has no account system.

## Updates and portable projects

Run `docker compose up --build -d` after updating source. Rebuilds regenerate content-addressed tool files and their manifest. Export open projects before changing hostnames, browsers or releases. Browser storage belongs to an origin; a different hostname, scheme or port has separate storage.

Projects pin exact tool bytes and versions. To reproduce analysis, retain the original release image and use its exported project. A newer release can inspect existing results and notes but cannot silently substitute a different analysis tool for a project's pin.

Container tags track their selected release lines (`node:24-alpine`, `nginxinc/nginx-unprivileged:1.28-alpine`, `caddy:2-alpine`). Dependency versions are exact and locked in `package-lock.json`; pin container image digests as part of a controlled production release process.

## Smoke checks

```sh
docker compose config --quiet
docker compose up --build --wait
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8080/tools/manifest.json
curl -I http://localhost:8080/
curl -i -X POST http://localhost:8080/
```

Expect health `ok`, a manifest with a SHA-256 integrity field, a Content-Security-Policy header, and HTTP 405 for POST. There is no upload endpoint. Automated CI runs these checks on a Linux Docker host.

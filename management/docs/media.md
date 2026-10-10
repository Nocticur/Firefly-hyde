# Private media and publication

Media metadata is stored as versioned `media` records in Cloudflare D1. Uploading
or importing an image saves a private R2 object and never publishes it. Articles
and settings retain `media:<uuid>` references; the publication service resolves
them through `publishMedia`, which verifies the private SHA-256 and creates an
immutable `published/<sha256>.<extension>` public R2 object. A repeated promotion
reuses the same verified object and URL. Original private objects remain available
for authenticated editing and recovery.

## Stores

- Configure separate `PRIVATE_MEDIA` and `PUBLIC_MEDIA` R2 bindings. Only the
  public bucket has a public/custom domain, configured as `MEDIA_ORIGIN`.
- The private bucket has no public domain. Reads always pass through the
  administrator's authenticated `/api/media/:id/content` endpoint.
- Local development requires `PLATFORM=local`, `ENVIRONMENT=development`, and
  `NODE_ENV=development`. `LOCAL_MEDIA_PATH` selects the development directory.
  Node filesystem imports are isolated in the development adapter. Production
  and preview fail with `CONFIG_REQUIRED` instead of falling back to local files.

PNG, JPEG, GIF, WebP, AVIF, ICO and static SVG images are limited to 10 MiB. Raster
signatures must match the declared content type. SVG uses static element and
attribute allowlists; script, event handlers, styles, active XML declarations,
external references and ambiguous markup are rejected. Imported files receive
the same validation as uploads. Browser uploads use the authenticated, CSRF
protected multipart endpoint; no storage credentials are sent to the browser.

## API

Every media route requires the administrator's session. Writes additionally
require the same-origin `X-CSRF-Token`.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/media` | — | `{ items }`, each with a version |
| `POST /api/media/upload` | multipart `file`, `alt`, `caption` | `{ media }` |
| `POST /api/media/import` | `{ url, alt, caption }` | `{ media }` |
| `PATCH /api/media/:id` | `{ version, alt, caption }` | `{ media }`; stale version is `409` |
| `GET /api/media/:id/content` | — | authenticated private bytes, `no-store`, `nosniff`, sandbox CSP |

The service bounds multipart bytes before parsing them and checks the actual
file bytes and content type before storing a media record. Metadata retains the
original filename, alt text, caption, owner, byte size, SHA-256 and version.

External imports require HTTPS and an exact trusted host in the comma/whitespace
separated `MEDIA_IMPORT_HOSTS` list. There are no wildcard or suffix matches.
Credentials, alternative ports, local hostnames, private/special addresses and
redirects are rejected. A/AAAA answers are checked using the fixed HTTPS resolver
`https://cloudflare-dns.com/dns-query`; deployment egress must permit that service
and the explicitly trusted media hosts. The allowlist is an administrator trust
boundary and should contain only hosts controlled or trusted by the site owner.

## Validation

`pnpm exec tsx --test tests/media.test.ts` covers MIME mismatch and size limits,
active SVG rejection, import URL and DNS checks, redirect rejection, session and
CSRF enforcement, owner isolation, private/public R2 separation, immutable
promotion, metadata conflicts, SQLite/filesystem restart persistence and missing
production configuration. R2 tests use its real binding contract. Actual remote
R2 upload, download and public-domain access require the configured cloud buckets
and are part of deployment acceptance.

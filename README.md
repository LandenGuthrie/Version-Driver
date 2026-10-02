# Version Driver

Encrypted, compressed version control that stores your projects in your own Google Drive.
Commit, push, branch, revert and share with teammates. Images and audio get real previews,
and everything is encrypted on your machine before it leaves it.

## Layout

| Folder | What it is |
|---|---|
| `core/` | The engine: chunking, compression, encryption, branches, sync, sharing. No UI. Has tests. |
| `app/`  | The Electron desktop app (main process, preload, React UI). |

Installers are **not** part of this repository. They are built into `../installers/` (next to this `src` folder)
(and published as GitHub Release assets), so the source stays small.

## Build from source

Requires Node 22+ and git.

```bash
git clone <this repo> && cd version-driver
npm install
cp app/.env.example app/.env.local      # then add your Google OAuth client id/secret
npm test                                # engine tests
npm run dev                             # run the desktop app in development
npm run dist -w app                     # build the installer into ../installers
```

On Windows, run builds from the real path rather than through a `subst` drive letter.

## Google setup

Create an OAuth client of type **Desktop app**, enable the **Google Drive API**, and add the scopes
`openid`, `userinfo.email`, `userinfo.profile` and `drive.file`. While the app is in "Testing",
add every account that needs to sign in as a test user.

## Releasing

Installers are published as **GitHub Releases** by `.github/workflows/release.yml`.

One-time setup: in the repo go to *Settings → Secrets and variables → Actions* and add
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

To publish a version:

```bash
# 1. bump "version" in app/package.json, e.g. 0.2.0, and commit
git tag v0.2.0
git push --tags
```

A few minutes later the Windows, macOS and Linux installers appear under **Releases**. Installed copies
check for new releases automatically and offer a restart when one has downloaded.

Builds are unsigned, so Windows SmartScreen ("More info → Run anyway") and macOS Gatekeeper
(right-click → Open) will warn on first launch.

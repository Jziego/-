# BGM seed assets

`prisma/seed.ts` inserts **metadata rows** for the system BGM library into the
`BgmTrack` table. Each row points at an object in R2 via `storageKey`
(e.g. `bgm/bgm_upbeat_01.mp3`).

The **actual mp3 files are not in this repo** — they must be uploaded to R2
manually (ops step) so the worker can fetch them at render time:

```
bgm/bgm_upbeat_01.mp3
bgm/bgm_calm_01.mp3
bgm/bgm_corporate_01.mp3
```

Use any royalty-free 30s clips. To add more tracks later: upload the mp3 to R2
under `bgm/` and insert a `BgmTrack` row — no redeploy required (Q3 decision).
